// The share card's rasteriser, left out of the build. `VOIDBASE_SEO_PNG` is off (its default), so the Workers build
// aliases `#platform/raster` here instead of at raster.ts and resvg's 2.4 MB wasm and the card's font never enter
// the bundle: an instance that serves no share card is not charged for one (docs/platform.md).
//
// The contract is the one raster.ts keeps: null, never a throw. The .png route answers the card's SVG body with
// `X-Voidbase-Card: svg-fallback`, and the meta answer names the .svg, so nothing points a scraper at a PNG that
// is not there.
export const rasterize = async (_svg: string, _width: number, _height: number): Promise<Uint8Array | null> => null;
