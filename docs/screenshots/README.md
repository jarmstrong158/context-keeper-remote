# Screenshots

**Every one of these is synthetic.** The four projects — `acme-api`, `billing`,
`docs-site`, `ingest` — are invented, and so is every decision, constraint and
pipeline in them. `seed.sql` is the whole dataset.

That is not caution for its own sake. This repository is public, and a screenshot
of a real store publishes project names and decision summaries permanently, in a
form nobody thinks to grep for before pushing. It has already happened once here:
a proposal file carrying content from a private repo and one with no remote was
committed and had to be force-removed from history (`con-015` in context-keeper).
A picture is the easiest way to leak, because it does not look like data.

## Regenerating

Screenshots go stale silently — the UI changed substantially the day these were
taken. To redo them:

```bash
printf 'VIEW_TOKEN=demo-screenshot-token\n' > .dev.vars
npx wrangler dev --port 8787
# in another shell:
npx wrangler d1 execute context-keeper --local --file docs/screenshots/seed.sql
```

Then capture each page at **500px wide**. Narrower crops rather than reflows:
headless Chrome clamps its minimum layout width, so `--window-size=390` lays the
page out at ~500 and then cuts the right-hand side off every line, which looks
like a CSS bug and is not one.

```bash
chrome --headless=new --disable-gpu --hide-scrollbars --window-size=500,900 \
  --screenshot=docs/screenshots/2-entry.png \
  "http://localhost:8787/view/demo-screenshot-token?e=dec-001"
```

Use the `/view/<token>` form, not the bare `/view` path — headless Chrome has no
enrolment cookie, so the tokenless path returns 404 and you get four identical
screenshots of an error page.

They render in light mode because that is what headless Chrome reports for
`prefers-color-scheme`. The page is theme-aware and looks like the dark version
on most phones; both are accurate.

Afterwards, delete `.dev.vars`.
