import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { joinOwnedProcessGroup, startupMarker } from "./owned-process-group.ts";

const pause = (ms: number) => new Promise<void>((accept) => setTimeout(accept, ms));

test("group join observes a held listener after its owned wrapper exits", {
  skip: process.platform === "win32",
  timeout: 25000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-owned-group-"));
  const release = join(directory, "release"),
    ready = join(directory, "ready"),
    descendant = join(directory, "listener.mjs"),
    wrapper = join(directory, "wrapper.mjs");
  await writeFile(
    descendant,
    `
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const server = createServer((request, response) => response.end("held-owned-listener"));
server.listen(0, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(ready)}, String(server.address().port));
});
const poll = setInterval(() => {
  if (existsSync(${JSON.stringify(release)})) finish();
}, 10);
// Self-expiry bounds fixture lifetime even if the test runner disappears.
const expiry = setTimeout(finish, 20000);
function finish() {
  clearInterval(poll);
  clearTimeout(expiry);
  server.close();
}
`,
  );
  await writeFile(
    wrapper,
    `
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" }).unref();
`,
  );
  const root = spawn(process.execPath, [wrapper], { detached: true, stdio: "ignore" });
  const exited = new Promise<void>((accept, reject) => {
    root.once("error", reject);
    root.once("exit", (code, signal) => {
      if (code === 0 && signal === null) accept();
      else reject(new Error("Owned fixture wrapper failed"));
    });
  });
  try {
    assert.ok(root.pid);
    await exited;
    let port: number | undefined;
    const deadline = performance.now() + 5000;
    while (port === undefined) {
      try {
        port = Number(await readFile(ready, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (port !== undefined) break;
      assert.ok(performance.now() < deadline, "Owned listener must announce readiness");
      await pause(25);
    }
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const checkListener = async () => {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(1000),
        headers: { Connection: "close" },
      });
      assert.equal(await response.text(), "held-owned-listener");
    };
    await checkListener();
    const began = performance.now();
    await assert.rejects(joinOwnedProcessGroup(root.pid), /exit unconfirmed after 5000ms/);
    assert.ok(performance.now() - began >= 5000, "A live descendant must hold the full barrier");
    await checkListener(); // A destructive observer would have stopped this listener.
    let joined = false;
    const pending = joinOwnedProcessGroup(root.pid).then(() => {
      joined = true;
    });
    try {
      await pause(100);
      assert.equal(joined, false, "Wrapper exit alone must not satisfy group join");
      await checkListener();
    } finally {
      await writeFile(release, "release");
      await pending;
    }
    assert.equal(joined, true);
  } finally {
    // Release first. Never signal a cached PGID after the owned leader exited.
    await writeFile(release, "release");
    await exited;
    if (root.pid) await joinOwnedProcessGroup(root.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup markers expose only explicit code categories", () => {
  for (const [output, marker] of [
    ["Error: listen EADDRINUSE: private-address", "address-in-use"],
    ["MiniflareCoreError [ERR_ADDRESS_IN_USE]: private-address", "address-in-use"],
    ["Error [ERR_MODULE_NOT_FOUND]: private-module", "module-unavailable"],
    ["code: 'ENOMEM', private-detail", "memory"],
    ["code: 'EACCES', private-path", "permission"],
    ["code: 'ENOENT', private-path", "filesystem"],
    ["[ERR_RUNTIME_FAILURE] private-detail", "runtime"],
  ] as const)
    assert.equal(startupMarker(output), marker);
  for (const output of [
    "private-canary: address already in use; module unavailable; out of memory; permission denied",
    "The service was stopped; runtime failed; no such file",
    "prefixEADDRINUSE EADDRINUSE_suffix ERR_MODULE_NOT_FOUND_suffix",
    "prefixERR_ADDRESS_IN_USE ERR_ADDRESS_IN_USE_suffix",
    "Ready on http://127.0.0.1:1234/ private-canary",
    "",
  ])
    assert.equal(startupMarker(output), "unknown");
});
