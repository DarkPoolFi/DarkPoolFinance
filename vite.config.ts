// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // The shielded-pool provers load WASM (and bb.js worker threads) from files next to their modules, so they ship as
  // traced node_modules in the server function instead of being bundled.
  // (traceDeps is forwarded to nitro but missing from the wrapper's deliberately narrow option type.) bb.js's WASM and
  // worker scripts are loaded by path, so scripts/ship-provers.mjs copies them in after the build.
  nitro: { traceDeps: ["@aztec/bb.js", "@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"] } as { preset?: string },
  // noir's WASM packages must not be pre-bundled in dev (their init fetches the .wasm next to the module).
  vite: { optimizeDeps: { exclude: ["@aztec/bb.js", "@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"] } },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
