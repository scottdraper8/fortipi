import { getNativeClipboard } from "@earendil-works/pi-tui";

/** Receives text only on stdin; no credentials, argv text or OSC52 fallback. */
async function main(): Promise<void> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 65536) throw new Error("bounded");
    chunks.push(bytes);
  }
  const clipboard = getNativeClipboard();
  if (!clipboard?.setText) {
    process.exitCode = 1;
    return;
  }
  await clipboard.setText(Buffer.concat(chunks).toString("utf8"));
}
void main().catch(() => {
  process.exitCode = 1;
});
