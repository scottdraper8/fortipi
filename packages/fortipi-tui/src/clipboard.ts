import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { helperEnvironment } from "./credentials.js";

export type CopyResult = { ok: boolean; message: string };
/** Compiled helper is a separate, killable process; clipboard/native display hangs cannot block input. */
export async function copyText(
  text: string,
  helper = fileURLToPath(new URL("./clipboard-helper.js", import.meta.url)),
  timeoutMs = 500,
): Promise<CopyResult> {
  if (Buffer.byteLength(text) > 65536)
    return { ok: false, message: "Copy exceeds 64 KiB; select the text instead" };
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(process.execPath, [helper], {
      stdio: ["pipe", "ignore", "ignore"],
      env: helperEnvironment(),
      windowsHide: true,
    });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      if (!ok) child.kill("SIGKILL");
      resolve({ ok, message: ok ? "Copied" : "Clipboard unavailable; select the text instead" });
    };
    const timer = setTimeout(() => finish(false), Math.min(500, timeoutMs));
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(text);
  });
}
