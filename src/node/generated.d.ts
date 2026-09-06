// src/node/embedded.generated.json exists only while scripts/build-exe.ts compiles the executables
declare module "*embedded.generated.json" { const value: import("./embedded").Embedded; export default value; }
