import assert from "node:assert/strict";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { spawnOwnedRuntime } from "../owned-runtime.ts";

test("owned supervisor retains its live capability after inner exit, joins drained pipes, and preserves SIGKILL", {
  skip: process.platform === "win32",
  timeout: 20000,
}, async () => {
  const fixture = resolve(import.meta.dirname, "owned-runtime.fixture.ts");
  for (const mode of ["early-exit", "held-command", "slow-drain"] as const) {
    const runtime = spawnOwnedRuntime([fixture, mode], {
      cwd: import.meta.dirname,
      env: {},
    });
    let stdout = "",
      stderr = "";
    let stdoutEnded = false,
      stderrEnded = false;
    const out = runtime.root.stdout,
      err = runtime.root.stderr;
    assert.ok(out && err);
    out.on("data", (bytes: Buffer) => {
      stdout += bytes.toString();
    });
    err.on("data", (bytes: Buffer) => {
      stderr += bytes.toString();
    });
    out.once("end", () => {
      stdoutEnded = true;
    });
    err.once("end", () => {
      stderrEnded = true;
    });
    try {
      const deadline = performance.now() + 5000;
      while (!stdout.includes("owned-stdout-ready") || !stderr.includes("owned-stderr-ready")) {
        assert.ok(performance.now() < deadline, "Owned Node child must announce both held pipes");
        assert.equal(runtime.spawnError, false);
        await new Promise<void>((accept) => setTimeout(accept, 10));
      }
      if (mode === "early-exit") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            runtime.innerExit,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Inner exit was not reported")), 3000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        assert.equal(runtime.exited, true);
        assert.equal(runtime.exitCode, 17, "The actual inner exit is visible before pipe EOF");
        assert.equal(runtime.signalCode, null);
        assert.equal(runtime.root.exitCode, null, "The owned root must still be live");
        assert.equal(runtime.root.signalCode, null);
        assert.equal(stdoutEnded, false);
        assert.equal(stderrEnded, false);
        const stopping = runtime.stop("SIGTERM");
        await stopping; // Returns only after pipe closure AND actual group ESRCH.
        assert.equal(runtime.root.exitCode, 0);
        assert.equal(stdoutEnded, true);
        assert.equal(stderrEnded, true);
        assert.ok(stdout.includes("owned-stdout-drained"));
        assert.ok(stderr.includes("owned-stderr-drained"));
        assert.equal(runtime.stop("SIGKILL"), stopping, "No late signal after owned termination");
      } else if (mode === "slow-drain") {
        await runtime.stop("SIGTERM", { closeTimeoutMs: 10000 });
        assert.equal(runtime.root.exitCode, 0);
        assert.equal(stdoutEnded, true);
        assert.equal(stderrEnded, true);
        assert.ok(stdout.includes("owned-stdout-drained"));
        assert.ok(stderr.includes("owned-stderr-drained"));
      } else {
        assert.equal(runtime.exited, false);
        assert.equal(runtime.root.exitCode, null);
        await runtime.stop("SIGKILL");
        assert.equal(
          runtime.root.signalCode,
          "SIGKILL",
          "Abrupt stop must remain a real group kill",
        );
        assert.equal(stdoutEnded, true);
        assert.equal(stderrEnded, true);
      }
    } finally {
      await runtime.stop("SIGTERM");
    }
  }
});
