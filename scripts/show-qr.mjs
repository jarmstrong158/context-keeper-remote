// Prints a URL read from STDIN as a QR code, so a phone can enrol by camera.
//
// STDIN, not argv, and this is the whole reason the file exists rather than
// being a one-line `node -e` in the setup script: a URL passed as an argument
// is visible in the process list to every other user on the machine for the
// lifetime of the call, and the view URL is a credential. That is the same rule
// the rest of the setup obeys (con-001), and the QR step would have quietly
// broken it.
//
// Nothing here writes the URL anywhere. It is rendered as blocks and discarded.

import qrcode from "qrcode-terminal";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const url = input.trim();
  if (!url) {
    console.error("show-qr: nothing on stdin");
    process.exit(1);
  }
  // Error correction L: the code is read off a bright screen at close range,
  // where the failure mode is the code being too dense to resolve, not damage.
  // L keeps the module count down, which is what makes it scannable in a
  // terminal at all.
  qrcode.generate(url, { small: true, errorCorrectionLevel: "L" }, (code) => {
    console.log(code);
  });
});
