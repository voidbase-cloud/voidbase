// resvg on Bun: the same wasm, read off disk from the installed package rather than imported, because nothing
// bundles the local process. `import.meta.resolve` finds it through the package's own `exports` entry for the file.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { makeRasterize } from "../../server/plugins/og-raster";

/** the 1200x630 card as PNG bytes, or null when resvg could not be loaded or would not parse the SVG */
export const rasterize = makeRasterize(async () => readFile(fileURLToPath(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"))));
