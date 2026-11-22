import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  cancellationDiagnostic,
  cancellationGroupSource,
  cancellationObserverSource,
} from "./cancellation-fixture.ts";

test("actual POSIX descendant oracle accepts group termination and rejects a parent-only kill", {
  timeout: 20000,
}, async (context) => {
  // Host-only sensitivity control; this does not execute the Linux SEA, FUSE or container transport.
  for (const groupKill of [true, false]) {
    const directory = await mkdtemp(resolve(tmpdir(), "fortipi-cancel-oracle-"));
    const child = spawn("/bin/sh", ["-c", cancellationGroupSource], {
      cwd: directory,
      detached: true,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    const exited = once(child, "exit");
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      await rm(directory, { recursive: true, force: true });
      cleaned = true;
    };
    context.after(cleanup);
    assert.ok(child.pid);
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        if ((await readFile(resolve(directory, "pg-ready"), "utf8")) === "ready") break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      assert.ok(Date.now() < deadline, "Actual shell readiness missing");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    process.kill(groupKill ? -child.pid : child.pid, "SIGTERM");
    await exited;
    const observer = spawn("/bin/sh", ["-c", cancellationObserverSource], {
      cwd: directory,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    const [code] = await once(observer, "exit");
    assert.equal(code, groupKill ? 0 : 1, "Observer must distinguish actual descendant survival");
    if (groupKill)
      await assert.rejects(readFile(resolve(directory, "pg-survived")), { code: "ENOENT" });
    else assert.equal(await readFile(resolve(directory, "pg-survived"), "utf8"), "orphan");
    await cleanup();
  }
});

test("cancellation diagnostics retain failed status and sync counts without output or error contents", () => {
  const result = {
    status: "cancelled" as const,
    exitCode: 143,
    sync: { status: "pending" as const, applied: 0, skipped: [], error: "synthetic-private-text" },
    skipped: [],
    stdout: "synthetic-private-text",
    stderr: "synthetic-private-text",
  };
  const row = cancellationDiagnostic("cancel", result, 2, 100);
  assert.equal(row.exitCode, 143);
  assert.equal(row.syncStatus, "pending");
  assert.equal(row.syncErrorPresent, true);
  assert.ok(JSON.stringify(row).length < 512);
  assert.equal(JSON.stringify(row).includes("synthetic-private-text"), false);
  const skipped = {
    path: "/workspace/synthetic-private-text",
    mountRoot: "/workspace",
    op: "write" as const,
    reason: "read-only" as const,
  };
  const natural = cancellationDiagnostic(
    "cancel",
    {
      ...result,
      status: "completed",
      exitCode: 0,
      skipped: [skipped],
      sync: { status: "complete", applied: 0, skipped: [skipped, skipped] },
    },
    1,
    200,
  );
  assert.equal(natural.status, "completed");
  assert.equal(natural.exitCode, 0);
  assert.equal(natural.skippedCount, 1);
  assert.equal(natural.syncSkippedCount, 2);
  assert.equal(JSON.stringify(natural).includes("synthetic-private-text"), false);
});
