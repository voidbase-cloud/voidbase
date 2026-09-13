// A new version of a Worker, made by the Worker itself (voidbase-stories vanilla-rebuild.feature, "Rebuilding an instance
// on Cloudflare"): the modules a rebuild assembled uploaded as a version, that version deployed, and the object store the
// rebuild keeps its work in. Every call is the Cloudflare REST API with the instance's own token (VOIDBASE_REBUILD_TOKEN).
//
// A version keeps what the Worker already has: its bindings and secrets (`keep_bindings`, by type) and its static assets
// (`keep_assets`), so a rebuild changes code and nothing else. Uploading and deploying are two calls on purpose: the
// upload is a version that serves nothing yet, and the deploy is the restart onto it, which is also what a rollback is.
import type { ModuleFile } from "../server/rebuild/assemble";
import type { CfApi } from "./rest";

/** the binding types an instance has, every one kept as the Worker holds it */
export const KEEP_BINDINGS = [
  "plain_text", "json", "secret_text", "secret_key", "d1", "r2_bucket", "kv_namespace", "durable_object_namespace", "queue", "ratelimit",
  "workflow", "secrets_store_secret", "flagship", "analytics_engine", "ai", "send_email", "service", "version_metadata",
];

const MIME: Record<ModuleFile["type"], string> = { esm: "application/javascript+module", wasm: "application/wasm", text: "text/plain", data: "application/octet-stream" };

export interface VersionMeta { mainModule: string; compatibilityDate: string; compatibilityFlags: string[]; message: string; tag: string }

/** upload `modules` as a version of `script` that serves nothing until deployed; returns the version id */
export async function uploadVersion(cf: CfApi, account: string, script: string, modules: Map<string, ModuleFile>, m: VersionMeta): Promise<string> {
  const metadata = {
    main_module: m.mainModule, compatibility_date: m.compatibilityDate, compatibility_flags: m.compatibilityFlags,
    bindings: [], keep_bindings: KEEP_BINDINGS, keep_assets: true,
    annotations: { "workers/message": m.message.slice(0, 900), "workers/tag": m.tag.slice(0, 100) },
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  for (const [path, mod] of modules) form.append(path, new Blob([mod.bytes as BlobPart], { type: MIME[mod.type] }), path);
  const r = await cf.form<{ id?: string }>("POST", `/accounts/${account}/workers/scripts/${script}/versions`, form);
  if (!r.result?.id) throw new Error(`Cloudflare took the version of ${script} but named no version id`);
  return r.result.id;
}

/** put `versionId` on all of `script`'s traffic; `force` passes a rollback over a version whose secrets have changed since */
export async function deployVersion(cf: CfApi, account: string, script: string, versionId: string, message: string, force = false): Promise<string> {
  const r = await cf.json<{ id?: string }>("POST", `/accounts/${account}/workers/scripts/${script}/deployments${force ? "?force=true" : ""}`, {
    strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }], annotations: { "workers/message": message.slice(0, 900) },
  });
  return r.result?.id ?? "";
}

/** the version most of `script`'s traffic goes to now, and the tag it was uploaded with; null when nothing is deployed */
export async function deployedVersion(cf: CfApi, account: string, script: string): Promise<{ versionId: string; tag?: string } | null> {
  const d = await cf.json<{ deployments?: { versions?: { version_id: string; percentage: number }[] }[] }>("GET", `/accounts/${account}/workers/scripts/${script}/deployments`);
  const top = [...(d.result?.deployments?.[0]?.versions ?? [])].sort((a, b) => b.percentage - a.percentage)[0];
  if (!top) return null;
  const v = await cf.json<{ annotations?: Record<string, string> }>("GET", `/accounts/${account}/workers/scripts/${script}/versions/${top.version_id}`);
  return { versionId: top.version_id, tag: v.result?.annotations?.["workers/tag"] };
}

/** an object into an R2 bucket through the REST API: how provisioning copies the release into the instance's own bucket */
export async function putObject(cf: CfApi, account: string, bucket: string, key: string, bytes: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
  const res = await cf.raw("PUT", `/accounts/${account}/r2/buckets/${bucket}/objects/${key.split("/").map(encodeURIComponent).join("/")}`, { body: bytes as BodyInit, headers: { "content-type": contentType } });
  if (!res.ok) throw new Error(`R2 ${bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}
