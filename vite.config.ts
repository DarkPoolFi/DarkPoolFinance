// The TanStack Start config preset already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const ISOLATED = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };

export default defineConfig({
  nitro: {
    // The shielded-pool provers load WASM (and bb.js worker threads) from files next to their modules, so they ship as
    // traced node_modules in the server function instead of being bundled.
    // (traceDeps is forwarded to nitro but missing from the wrapper's deliberately narrow option type.) bb.js's WASM and
    // worker scripts are loaded by path, so scripts/ship-provers.mjs copies them in after the build.
    traceDeps: ["@aztec/bb.js", "@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"],
    // TU-18: the pool cron can prove two or three times in one run; its worst logged run took 424 s (tree batch), so the
    // one server function gets 800 s (the Pro maximum) rather than the project default. Not per route: a
    // functionRules entry becomes a second function, which scripts/ship-provers.mjs does not fill with bb.js's files.
    vercel: { functions: { maxDuration: 800 } },
    // Every response is cross-origin isolated (TU-20), so bb.js can prove with threads (SharedArrayBuffer). Site-wide,
    // not only /dashboard: isolation is fixed when a document loads, so a visitor arriving on / and navigating client
    // side would otherwise prove on one thread. What the pages load from other origins allows it: Google Fonts sends
    // Cross-Origin-Resource-Policy: cross-origin, and bb.js fetches its CRS with CORS.
    routeRules: {
      "/**": { headers: ISOLATED },
      // nitro's own /assets rule (long cache) matches first and ends routing there, so it has to carry them too: the
      // proving worker and bb.js's thread workers are /assets files, and a worker needs COEP on its own script.
      "/assets/**": { headers: { ...ISOLATED, "cache-control": "public, max-age=31536000, immutable" } },
    },
  } as { preset?: string },
  // noir's WASM packages must not be pre-bundled in dev (their init fetches the .wasm next to the module).
  // ES worker output so the proving worker (src/shielded/prove.worker.ts) can code-split: at the default "iife" the two
  // 4 MB bb.js WASM modules are inlined into one file and the browser downloads both.
  vite: { optimizeDeps: { exclude: ["@aztec/bb.js", "@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"] }, worker: { format: "es" } },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
