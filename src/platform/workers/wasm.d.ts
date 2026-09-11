// A `.wasm` import is a compiled module on workerd, which is what the Workers build and the runtime both hand over.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
