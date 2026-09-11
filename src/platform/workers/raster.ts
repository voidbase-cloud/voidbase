// resvg on workerd: the wasm is a module import, so the build bundles it beside the Worker and the runtime compiles
// it once, the way @cf-wasm/photon does for the thumbnails. The import lives in this file alone, and the file is
// only reached through a dynamic `import("#platform/raster")` on the first .png card, so the ~2.4 MB module is not
// part of any other request's startup.
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import { makeRasterize } from "../../server/plugins/og-raster";

/** the 1200x630 card as PNG bytes, or null when resvg could not be loaded or would not parse the SVG */
export const rasterize = makeRasterize(async () => wasm);
