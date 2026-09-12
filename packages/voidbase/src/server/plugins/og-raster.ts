// The share card as a PNG: resvg (Rust -> wasm) over the SVG the card builder writes.
//
// Social scrapers do not render SVG, so a card that is only ever served as SVG is a card no one sees. resvg is the
// maintained SVG rasteriser that runs on workerd, and the two `#platform/raster` modules differ only in where the
// wasm comes from (a module import the Workers build bundles, a file read on Bun), so the rendering itself lives
// here. Two rules hold this together:
//   - the wasm is instantiated lazily and once per isolate, so a request that never asks for a card pays nothing;
//   - nothing here throws. A rasteriser that cannot load, or an SVG it will not parse, is a null, and the route
//     serves the SVG instead. A share image is not worth a 500.
// The fonts are the card's own (og-font.ts): a Worker has no system fonts, and resvg with none renders blank text.
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { logger } from "#platform/log";
import { OG_FONT_FAMILY, ogFontBuffers } from "./og-font";

/** what `initWasm` takes: the compiled module a bundler hands over, or the bytes read from the package */
export type WasmSource = WebAssembly.Module | BufferSource;

const failed = (what: string, err: unknown): null => {
  logger.warn(`voidbase: seo: ${what}`, { error: err instanceof Error ? err.message : String(err) });
  return null;
};

/**
 * A `rasterize(svg, width, height)` over one platform's way of getting at the wasm. The load runs at most once per
 * isolate: its promise is kept whether it settled or not, so a platform that cannot load it is not retried on every
 * request, and every caller after the first sees the same answer.
 */
export function makeRasterize(load: () => Promise<WasmSource>): (svg: string, width: number, height: number) => Promise<Uint8Array | null> {
  let ready: Promise<boolean> | null = null;
  const init = () => (ready ??= (async () => { await initWasm(await load()); return true; })().catch((err) => failed("the share card's rasteriser (resvg) could not be loaded; the card is served as SVG", err) ?? false));
  return async (svg, width, height) => {
    if (!(await init())) return null;
    try {
      const resvg = new Resvg(svg, {
        font: { fontBuffers: ogFontBuffers(), defaultFontFamily: OG_FONT_FAMILY, loadSystemFonts: false },
        fitTo: { mode: "width", value: width },
      });
      const image = resvg.render();
      const png = image.asPng();
      if (image.width !== width || image.height !== height) logger.warn("voidbase: seo: the share card rasterised to a size the route did not ask for", { asked: `${width}x${height}`, got: `${image.width}x${image.height}` });
      image.free();
      resvg.free();
      return png;
    } catch (err) { return failed("the share card could not be rasterised; it is served as SVG", err); }
  };
}
