// `voidbase serve --tunnel`: the instance on the internet through a Cloudflare quick tunnel (try.cloudflare.com).
// cloudflared does the work: VOIDBASE_CLOUDFLARED names the binary, else the one on PATH, else the release binary
// is downloaded once into ~/.cache/voidbase/cloudflared. The tunnel runs as a child of the server and goes when
// the server goes. Without cloudflared the server still serves, minus the tunnel, and says so in one line.
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { cacheRoot } from "./panel";

/** The asset name of cloudflared's GitHub release for a platform, or null where Cloudflare publishes none. */
export function cloudflaredAsset(platform: string = process.platform, arch: string = process.arch): string | null {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!os || !cpu || (os === "windows" && cpu !== "amd64")) return null;
  return `cloudflared-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

export const CLOUDFLARED_RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download";

export interface FindOptions {
  /** the environment to consult (VOIDBASE_CLOUDFLARED, PATH, the cache location); default process.env */
  env?: Record<string, string | undefined>;
  /** where a downloaded binary goes; default <cache root>/cloudflared */
  cacheDir?: string;
  /** the fetch to download with; pass one that fails to keep a test off the network */
  fetch?: typeof fetch;
  platform?: string; arch?: string;
  log?: (line: string) => void;
}

/**
 * The cloudflared to run: the configured one, the one on PATH, the cached one, or a fresh download. Null when
 * there is none, after one line saying why.
 */
export async function findCloudflared(opts: FindOptions = {}): Promise<string | null> {
  const env = opts.env ?? process.env;
  const give = (reason: string) => { (opts.log ?? ((l) => console.log(l)))(`voidbase: ${reason}; serving without the tunnel`); return null; };
  const explicit = env.VOIDBASE_CLOUDFLARED;
  if (explicit) return existsSync(explicit) ? explicit : give(`VOIDBASE_CLOUDFLARED points at ${explicit}, which does not exist`);
  const onPath = Bun.which("cloudflared", { PATH: env.PATH ?? "" });
  if (onPath) return onPath;
  const asset = cloudflaredAsset(opts.platform, opts.arch);
  if (!asset) return give(`no cloudflared build for ${opts.platform ?? process.platform}/${opts.arch ?? process.arch}; install it and set VOIDBASE_CLOUDFLARED`);
  const dir = opts.cacheDir ?? `${cacheRoot(env)}/cloudflared`;
  const bin = `${dir}/${asset.endsWith(".exe") ? "cloudflared.exe" : "cloudflared"}`;
  if (existsSync(bin)) return bin;
  const url = `${CLOUDFLARED_RELEASES}/${asset}`;
  (opts.log ?? ((l) => console.log(l)))(`voidbase: downloading cloudflared into ${bin}`);
  try {
    const res = await (opts.fetch ?? fetch)(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mkdirSync(dir, { recursive: true });
    // written beside its final name and moved into place, so a half download never passes for the binary
    const partial = `${bin}.part`;
    writeFileSync(partial, new Uint8Array(await res.arrayBuffer()));
    try { chmodSync(partial, 0o755); } catch { /* Windows has no mode bits */ }
    renameSync(partial, bin);
    return bin;
  } catch (e) {
    return give(`could not download cloudflared from ${url} (${e instanceof Error ? e.message : String(e)}); install it or set VOIDBASE_CLOUDFLARED`);
  }
}

export interface Tunnel {
  /** the public https://<words>.trycloudflare.com address */
  url: string;
  pid: number;
  /** ends the tunnel; safe to call more than once */
  stop: () => void;
  /** resolves with cloudflared's exit code once it has gone */
  exited: Promise<number>;
}

export interface StartOptions {
  /** how long to wait for the address before giving up (cloudflared usually has it in a few seconds); default 30 s */
  timeoutMs?: number;
  log?: (line: string) => void;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * Runs `cloudflared tunnel --url http://127.0.0.1:<port>` and waits for the address it prints (in a boxed banner,
 * on stderr). Null when cloudflared exits or stays silent past the timeout; the process is gone either way.
 */
export async function startTunnel(bin: string, port: number, opts: StartOptions = {}): Promise<Tunnel | null> {
  const log = opts.log ?? ((l) => console.log(l));
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([bin, "tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    log(`voidbase: could not run ${bin} (${e instanceof Error ? e.message : String(e)}); serving without the tunnel`);
    return null;
  }
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; try { proc.kill(); } catch { /* already gone */ } };
  // the address arrives on either stream; both are drained for the life of the process so cloudflared never
  // blocks on a full pipe, and the first match wins
  let found: (url: string) => void = () => undefined;
  const urlPromise = new Promise<string>((r) => { found = r; });
  const tail: string[] = [];
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    let buffer = "";
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) { tail.push(line); if (tail.length > 20) tail.shift(); const m = URL_RE.exec(line); if (m) found(m[0]); }
    }
    const m = URL_RE.exec(buffer); if (m) found(m[0]);
  };
  void drain(proc.stdout).catch(() => undefined); void drain(proc.stderr).catch(() => undefined);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race<{ url: string } | { exit: number } | { timeout: true }>([
    urlPromise.then((url) => ({ url })),
    proc.exited.then((exit) => ({ exit })),
    new Promise((r) => { timer = setTimeout(() => r({ timeout: true }), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!("url" in outcome)) {
    stop();
    const why = "exit" in outcome ? `cloudflared exited with ${outcome.exit}` : `cloudflared gave no address within ${timeoutMs / 1000}s`;
    const hint = tail.filter((l) => /ERR|error|failed/i.test(l)).slice(-1)[0];
    log(`voidbase: ${why}${hint ? ` (${hint.trim()})` : ""}; serving without the tunnel`);
    return null;
  }
  return { url: outcome.url, pid: proc.pid, stop, exited: proc.exited };
}

/** Everything `--tunnel` does: find or fetch cloudflared, run it for the port, hand back the address. Null means no tunnel. */
export async function openTunnel(port: number, opts: FindOptions & StartOptions = {}): Promise<Tunnel | null> {
  const bin = await findCloudflared(opts);
  return bin ? startTunnel(bin, port, { timeoutMs: opts.timeoutMs, log: opts.log }) : null;
}

/** Ends the tunnel when the process does: SIGINT, SIGTERM and a plain exit all take cloudflared down with them. */
export function attachToProcess(tunnel: Tunnel): void {
  const bye = () => { tunnel.stop(); process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
  process.on("exit", () => tunnel.stop());
}
