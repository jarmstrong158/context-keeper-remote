// The install path is auth code. Its whole job is to let a device back in
// without a token in the URL, which is exactly the shape of change that widens
// access by accident -- so these tests are mostly about what must STILL fail.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { COOKIE_NAME, readCookie } from "../src/install";

const VIEW = "view-token-for-tests";
const AUTH = "auth-token-for-tests";
const BASE = "https://example.com";

async function call(path: string, init: RequestInit = {}, overrides: Record<string, unknown> = {}) {
  const request = new Request(`${BASE}${path}`, init);
  const ctx = createExecutionContext();
  const testEnv = { ...env, VIEW_TOKEN: VIEW, AUTH_TOKEN: AUTH, ...overrides };
  const res = await worker.fetch(request, testEnv as Env);
  await waitOnExecutionContext(ctx);
  return res;
}

const withCookie = (value: string) => ({ headers: { cookie: `${COOKIE_NAME}=${value}` } });

describe("enrolling with the token", () => {
  it("serves the page and hands back a cookie", async () => {
    const res = await call(`/view/${VIEW}`);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toContain(VIEW);
  });

  it("marks the cookie HttpOnly, Secure, SameSite=Lax and scopes it to /view", async () => {
    const setCookie = (await call(`/view/${VIEW}`)).headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    // Path=/view keeps it off /mcp, which authenticates on a different secret.
    expect(setCookie).toContain("Path=/view");
  });

  it("does not hand out a cookie to a wrong token", async () => {
    const res = await call("/view/not-the-token");
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("using it afterwards, with no token in the URL", () => {
  it("serves /view to a device holding the cookie", async () => {
    const res = await call("/view", withCookie(VIEW));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("serves /view/ as well", async () => {
    expect((await call("/view/", withCookie(VIEW))).status).toBe(200);
  });

  it("404s /view with no cookie at all", async () => {
    expect((await call("/view")).status).toBe(404);
  });

  it("404s /view with a wrong cookie", async () => {
    expect((await call("/view", withCookie("wrong"))).status).toBe(404);
  });

  it("does not accept the AUTH_TOKEN as a view cookie", async () => {
    // The two credentials stay separate: holding the read/write connector token
    // must not grant the view, or the split was decorative.
    expect((await call("/view", withCookie(AUTH))).status).toBe(404);
  });
});

describe("rotation is the only revocation path", () => {
  it("drops every enrolled device the moment VIEW_TOKEN changes", async () => {
    expect((await call("/view", withCookie(VIEW))).status).toBe(200);
    const after = await call("/view", withCookie(VIEW), { VIEW_TOKEN: "rotated-to-something-else" });
    expect(after.status).toBe(404);
  });

  it("404s everything when VIEW_TOKEN is unset, cookie or not", async () => {
    // Unset means the feature is off and must be indistinguishable from a route
    // that was never deployed -- a cookie must not resurrect it.
    expect((await call("/view", withCookie(VIEW), { VIEW_TOKEN: undefined })).status).toBe(404);
    expect((await call(`/view/${VIEW}`, {}, { VIEW_TOKEN: undefined })).status).toBe(404);
    expect((await call("/view", withCookie(""), { VIEW_TOKEN: "" })).status).toBe(404);
  });
});

describe("installable assets", () => {
  it("serves the manifest to a cookie-holder, pointing the icon at the tokenless path", async () => {
    const res = await call("/view/manifest.webmanifest", withCookie(VIEW));
    expect(res.status).toBe(200);
    const m = JSON.parse(await res.text());
    // The payoff: the installed icon opens a URL with no secret in it.
    expect(m.start_url).toBe("/view");
    expect(m.scope).toBe("/view");
    expect(m.display).toBe("standalone");
    // A 192 is REQUIRED for Chrome on Android to offer installation at all.
    // Without it the browser degrades to a home-screen shortcut that opens in a
    // tab, silently -- which is exactly how this shipped the first time and how
    // it was reported: "it just took me to the HTML page. thats not an app".
    const sizes = new Set(m.icons.map((i: any) => i.sizes));
    expect(sizes.has("192x192"), "Chrome Android needs a 192x192 icon").toBe(true);
    expect(sizes.has("512x512")).toBe(true);
    // At least one maskable, so Android can clip it to the launcher shape
    // instead of framing it in a white rounded square.
    expect(m.icons.some((i: any) => i.purpose === "maskable")).toBe(true);
    expect(JSON.stringify(m)).not.toContain(VIEW);
  });

  it("serves a real PNG at both declared sizes", async () => {
    // Every size the manifest names must actually resolve. A manifest that
    // promises a 192 and 404s it is worse than not declaring one: the install
    // prompt still will not appear, and now the reason is invisible.
    for (const [path, dim] of [["/view/icon.png", 512], ["/view/icon-192.png", 192]] as const) {
      const res = await call(path, withCookie(VIEW));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe("image/png");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(Array.from(bytes.slice(0, 8)), path)
        .toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // IHDR width lives at bytes 16-19, big-endian: prove it is really the
      // size claimed rather than the same image relabelled.
      const w = new DataView(bytes.buffer).getUint32(16);
      expect(w, path).toBe(dim);
    }
  });

  it("404s assets without the cookie", async () => {
    expect((await call("/view/icon.png")).status).toBe(404);
    expect((await call("/view/manifest.webmanifest")).status).toBe(404);
  });

  it("does not let an asset path be mistaken for a token", async () => {
    // Both also match /^\/view\/([^/]+)$/. If ordering regressed, these would be
    // compared against VIEW_TOKEN and 404 even for an enrolled device.
    expect((await call("/view/icon.png", withCookie(VIEW))).status).toBe(200);
    expect((await call("/view/manifest.webmanifest", withCookie(VIEW))).status).toBe(200);
  });

  it("references the manifest with use-credentials, or the install prompt never appears", async () => {
    const html = await (await call(`/view/${VIEW}`)).text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('crossorigin="use-credentials"');
    expect(html).toContain('rel="apple-touch-icon"');
  });

  it("allows the page's own images and manifest in CSP, and nothing else", async () => {
    const csp = (await call(`/view/${VIEW}`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // script-src 'self' is required for app.js and the service worker. The
    // assertion that matters is what is still REFUSED: no 'unsafe-inline', so
    // an inline <script> -- including one a recorded entry smuggled past the
    // escaper -- cannot execute. An inline allowance is document-wide.
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp.match(/script-src[^;]*/)?.[0]).not.toContain("unsafe-inline");
  });
});

describe("the MCP route is untouched", () => {
  it("ignores a view cookie entirely", async () => {
    const res = await call("/mcp/wrong", { method: "POST", ...withCookie(VIEW) });
    expect(res.status).toBe(404);
  });

  it("still refuses non-POST on a valid token", async () => {
    expect((await call(`/mcp/${AUTH}`, { method: "GET" })).status).toBe(405);
  });
});

describe("cookie parsing", () => {
  const req = (cookie: string) => new Request(BASE, { headers: { cookie } });

  it("finds the value among others", () => {
    expect(readCookie(req(`a=1; ${COOKIE_NAME}=xyz; b=2`), COOKIE_NAME)).toBe("xyz");
  });

  it("does not match a cookie whose name merely ends with the target", () => {
    // A naive /ckv=([^;]*)/ would return "nope" here.
    expect(readCookie(req(`my${COOKIE_NAME}=nope`), COOKIE_NAME)).toBeNull();
  });

  it("keeps everything after the first = , since values may contain one", () => {
    expect(readCookie(req(`${COOKIE_NAME}=a=b=c`), COOKIE_NAME)).toBe("a=b=c");
  });

  it("percent-decodes, and survives a malformed escape without throwing", () => {
    expect(readCookie(req(`${COOKIE_NAME}=a%2Fb`), COOKIE_NAME)).toBe("a/b");
    expect(readCookie(req(`${COOKIE_NAME}=%zz`), COOKIE_NAME)).toBeNull();
  });

  it("returns null when there is no cookie header", () => {
    expect(readCookie(new Request(BASE), COOKIE_NAME)).toBeNull();
  });
});
