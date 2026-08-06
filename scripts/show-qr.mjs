// Prints a URL as a QR code, so a phone can enrol by camera.
//
// Reads the URL from STDIN when run directly, and that is the whole reason this
// is a file rather than a one-line `node -e` in the setup script: a URL passed
// as an argument is visible in the process list to every other user on the
// machine for the lifetime of the call, and the view URL is a credential. Same
// rule the rest of the setup obeys (con-001), which the QR step would otherwise
// have quietly broken.
//
// Nothing here writes the URL anywhere. It is rendered as blocks and discarded.

import { spawnSync } from "node:child_process";
import qrcode from "qrcode-terminal";

/**
 * Make the terminal capable of showing the code, then draw it.
 *
 * The encoding step is not cosmetic. The QR is drawn with the half-block
 * characters U+2580 / U+2584 / U+2588, which node emits as UTF-8. A Windows
 * console defaults to codepage 437, decodes each of those three-byte sequences
 * as three separate characters, and prints "ΓûêΓûÇΓûä" -- so the code arrives
 * as dense garbage no camera can lock onto. The failure is silent and reads as
 * "no QR was generated", when in fact it generated correctly and was destroyed
 * on the way to the screen.
 *
 * `chcp 65001` switches the console to UTF-8 for the rest of its life. That is
 * a side effect on the user's terminal, which is worth being deliberate about;
 * it is also the only thing that makes this work in the default Windows console,
 * and it makes every subsequent Unicode-emitting command behave better rather
 * than worse.
 */
export function showQr(url) {
  if (process.platform === "win32") {
    try {
      spawnSync("chcp", ["65001"], { shell: true, stdio: "ignore" });
    } catch {
      // Non-fatal: on a console that already speaks UTF-8 (Windows Terminal,
      // VS Code, most modern shells) the code renders correctly regardless.
    }
  }
  // Error correction L: read off a bright screen at close range, where the
  // failure mode is the code being too dense to resolve, not physical damage.
  // L keeps the module count down, which is what makes it scannable in a
  // terminal at all.
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true, errorCorrectionLevel: "L" }, (code) => {
      console.log(code);
      resolve();
    });
  });
}

// Run directly: take the URL from stdin.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", async () => {
    const url = input.trim();
    if (!url) {
      console.error("show-qr: nothing on stdin");
      process.exit(1);
    }
    await showQr(url);
  });
}
