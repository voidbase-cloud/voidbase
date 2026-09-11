// Node side of the Void adapter: the Vite plugin, the one-shot `adapt()` and the pieces they are made of.
// The runtime half (`mountVoidApp`) is a separate entry, "@voidbase-cloud/voidbase/adapter", because generated
// app code imports it and must stay free of node:fs so it bundles into a Worker.
export { adapt, voidbaseAdapter, type AdaptResult, type AdapterOptions } from "./plugin";
export { generateMainEntry, generateMigration, generateServerModule, splitSql, writeVoidbaseApp, type GenerateOptions, type WriteResult } from "./codegen";
export { exportedNames, routeUrl, scanVoidApp, type ScanOptions, type VoidManifest, type VoidMigration, type VoidModule, type VoidQueue, type VoidRoute } from "./scan";
export { alternateLinks, localeRules, pageUrl, resolveLocales, setLang, writeLocales, writeLocaleRedirects, type LocalesOptions, type LocalesResult } from "./locales";
export { generateManifest, generateServiceWorker, injectHead, insertIntoHead, precacheList, versionOf, writePwa, type PwaOptions, type PwaResult } from "./pwa";
