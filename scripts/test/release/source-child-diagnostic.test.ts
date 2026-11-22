// Transport-only check: ordinary owned Node children, no recovery/provider fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";

const mode = "FORTIPI_DIAGNOSTIC_STREAM_CHILD";
const wire =
  '# {"diagnostic":"source-live-recovery-await","invocation":"positive","step":"original-reader","event":"enter"}';
const privateCanary = "synthetic-private-stream-canary";
if (process.env[mode] === "1") {
  test("ordinary stderr observation fixture", { timeout: 3000 }, async () => {
    writeSync(2, `${wire}\n`);
    writeSync(2, `${privateCanary}\n`);
    await pause(750);
  });
} else {
  test("selected child diagnostics arrive before test exit without forwarding arbitrary stderr", {
    timeout: 10000,
  }, async () => {
    const child = spawn(
      process.execPath,
      [
        "--require",
        resolve(import.meta.dirname, "../../source-test-processes.ts"),
        "--test",
        "--test-reporter=tap",
        import.meta.filename,
      ],
      { env: { PATH: process.env.PATH, [mode]: "1" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "",
      stdout = "",
      beforeExit = false;
    const exit = once(child, "exit", { signal: AbortSignal.timeout(8000) });
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.includes(`${wire}\n`))
        beforeExit ||= child.exitCode === null && child.signalCode === null;
    });
    try {
      const [code, signal] = await exit;
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.equal(
        beforeExit,
        true,
        "A closed fd2 marker must be observable while its test child is still alive",
      );
      assert.equal(stderr.includes(privateCanary), false);
      assert.equal(
        stdout.includes(privateCanary),
        true,
        "The ordinary TAP channel remains independently captured",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  });
}
