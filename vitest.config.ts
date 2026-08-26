import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Sets the handful of env vars that modules validate at import time, so a
    // pure-logic test does not need a database or an API key.
    setupFiles: ["./src/test/setup-env.ts"],
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/analytics/**", "src/server/services/youtube/**"],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      /**
       * `server-only` throws on import unless it is being resolved by the
       * React Server Components bundler — which is the entire point of the
       * package, and which makes any server module importing it untestable
       * under a plain Node runner. The package ships an empty stub for exactly
       * this case, so the guard keeps protecting the real client bundle while
       * the tests can still reach the modules it protects.
       */
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
});
