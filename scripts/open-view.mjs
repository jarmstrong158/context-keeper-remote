// `npm run view` -- reopen the view without remembering anything.
//
// The setup script saves the URL to .view-url (gitignored) precisely so that
// nobody has to keep it. Cloudflare stores secrets write-only, so if the only
// copy was the clipboard, one Ctrl-C elsewhere meant re-running setup and
// invalidating every enrolled device. Storing it locally is what every CLI does
// with its own token -- npm, gh, aws, wrangler all keep one on disk -- and it
// is strictly better than the alternative it replaces, which was asking a
// person to hold a 43-character secret in their head or their password manager.

import { readFileSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const file = join(repo, ".view-url");

if (!existsSync(file)) {
  console.error(`
  No saved view URL.

  Run the setup once and it will be saved here automatically:

      npm run set-view-token

  There is no way to recover it otherwise -- Cloudflare cannot read a secret
  back, only replace it.
`);
  process.exit(1);
}

const url = readFileSync(file, "utf8").trim();
if (!url.startsWith("https://")) {
  console.error(`  ${file} does not contain a URL. Re-run: npm run set-view-token`);
  process.exit(1);
}

// Masked, never printed in full -- the same rule as everywhere else. Anyone who
// wants the literal value can cat the file; it should not land in scrollback
// just because someone opened their own dashboard.
const seg = url.split("/view/")[1] ?? "";
const mask = seg.length > 8 ? `${seg.slice(0, 4)}${".".repeat(12)}${seg.slice(-4)}` : "***";
const origin = url.split("/view/")[0];

// `npm run view -- --qr` enrols another device. Without this, adding a phone
// later would mean re-running setup, which mints a NEW token and silently drops
// every device already enrolled -- a rotation performed as a side effect of
// wanting a second device is exactly the kind of surprise this whole change is
// meant to remove.
if (process.argv.includes("--qr")) {
  const qr = (await import("qrcode-terminal")).default;
  console.log(`\n  Scan with the new device, then Add to Home Screen:\n`);
  qr.generate(url, { small: true, errorCorrectionLevel: "L" }, (code) => {
    console.log(code);
    console.log(`  ${origin}/view/${mask}\n`);
  });
  process.exit(0);
}

console.log(`\n  opening ${origin}/view/${mask}`);
console.log(`  saved ${statSync(file).mtime.toISOString().slice(0, 10)}\n`);

// Passing the URL as an argument here is unavoidable -- there is no stdin path
// for opening a browser -- and it is the same accepted exception the setup
// script documents: the browser holds the URL in its own argv and history
// regardless, so anyone who can read the process list can already read that.
const opener =
  process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
  : process.platform === "darwin" ? ["open", [url]]
  : ["xdg-open", [url]];

spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
