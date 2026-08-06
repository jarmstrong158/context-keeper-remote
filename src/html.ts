// The one HTML escaper.
//
// This existed three times -- in view.ts, detail.ts and health.ts -- byte
// identical by luck rather than by design. Three copies of an escaping function
// is a latent XSS hole: the copies only have to agree until someone "improves"
// one of them, and the one that drifts is the one nobody re-reads. Every string
// rendered by this Worker comes from the store, and the store contains whatever
// a project recorded, so this is the only thing standing between a recorded
// `<img src=x onerror=...>` and the page.
//
// It escapes both quote characters as well as the angle brackets, which matters
// because these templates interpolate into attribute values as well as text
// nodes -- `<a href="/view?e=${...}">` is only safe because `"` is covered.
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Truncate for a list row, with an ellipsis rather than a hard cut. */
export function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
