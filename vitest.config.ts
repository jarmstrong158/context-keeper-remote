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
        // Both are production secrets; supply fixed ones so the SELF.fetch
        // auth paths work. They are DIFFERENT values on purpose -- the tests
        // assert each route refuses the other's token, which is the whole
        // reason the view has its own credential.
        bindings: {
          AUTH_TOKEN: "test-secret-token",
          VIEW_TOKEN: "view-secret-token",
        },
        // wrangler.toml declares a service binding to cambium-remote, which
        // does not exist in a test run -- miniflare refuses to start at all,
        // with "The Workers runtime failed to start" and no mention of the
        // binding, so the whole suite dies rather than one test failing.
        //
        // Stubbed as an unreachable service on purpose rather than a fake that
        // returns counts: the Knowledge panel's contract is that a cambium
        // failure degrades to a stated absence and never breaks the page, and a
        // stub that always succeeds would stop testing that.
        serviceBindings: {
          CAMBIUM: () => new Response("Not Found", { status: 404 }),
        },
      },
    }),
  ],
});
