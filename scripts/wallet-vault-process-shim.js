// Tiny ESM re-export so esbuild's `inject` can map bare `process` references
// (used unconditionally by some of @0xbow/privacy-pools-core-sdk's bundled
// dependencies) to the standard browser `process` polyfill. esbuild's
// inject feature matches named exports against free identifiers in the
// bundle by name — the `process` npm package itself is CommonJS
// (`module.exports = process`), so it needs this named-export wrapper
// rather than being injected directly.
import process from 'process/browser.js';
export { process };
