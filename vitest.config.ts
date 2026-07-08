import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// vitest-pool-workers v0.18 (vitest v4) exposes its pool as the `cloudflareTest`
// plugin; the old `poolOptions.workers` object is passed to it directly.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Shared storage across the run: its lifetime matches the isolate, so the
      // per-isolate migration memo (WeakSet keyed on the D1 binding) stays
      // valid. Tests stay independent by using a unique project name each, and
      // the composite (project, id) primary key lets the same 'dec-001' id
      // coexist across those projects.
      isolatedStorage: false,
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // AUTH_TOKEN is a production secret; supply a fixed one for tests so the
        // SELF.fetch auth path works.
        bindings: { AUTH_TOKEN: "test-secret-token" },
      },
    }),
  ],
});
