/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings available to the Worker at runtime. The vitest pool types the test
// `env` as `Cloudflare.Env`, so the binding shape is declared in that namespace
// and re-exported as the global `Env` the Worker's fetch handler uses.
declare namespace Cloudflare {
  interface Env {
    // D1 database binding (see wrangler.toml [[d1_databases]]).
    DB: D1Database;
    // Secret-path auth token. Set in the Cloudflare dashboard, never in source.
    AUTH_TOKEN?: string;
    // Separate secret for the read-only /view/<token> HTML render. Distinct
    // from AUTH_TOKEN on purpose: the view URL gets opened on a phone, where a
    // read/write credential does not belong. Unset => the route 404s.
    VIEW_TOKEN?: string;
  }
}

interface Env extends Cloudflare.Env {}
