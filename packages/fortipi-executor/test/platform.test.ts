import assert from "node:assert/strict";
import { chmod, link, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { validateRelativePath } from "fortipi-contract/executor";
import { adapter, defaults, privateRead, privateWrite } from "../dist/config.js";
import { childEnvironment } from "../dist/platform/types.js";
import { checkManifest, scan } from "../dist/workspace/manifest.js";
import { eventually, fixture, fixtureChild, nodeCommand } from "./fixtures/daemon.ts";

test("native state protection, no-follow links, hardlinks, replacement and portable reserved paths", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, "protected.json");
    await privateWrite(path, "synthetic-private");
    assert.equal(await privateRead(path), "synthetic-private");
    await adapter().verifyProtection(path, false);
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await assert.rejects(privateRead(path), /permissions/);
      await chmod(path, 0o600);
    }
    const regular = join(f.rootPath, "regular");
    await writeFile(regular, "bytes");
    await link(regular, join(f.rootPath, "alias"));
    await assert.rejects(f.root.read("regular", 100), /link/);
    const external = join(f.path, "outside");
    await writeFile(external, "outside");
    if (process.platform === "win32")
      await symlink(f.directory, join(f.rootPath, "junction"), "junction");
    else await symlink(f.directory, join(f.rootPath, "junction"));
    await assert.rejects(f.root.read("junction/protected.json", 100), /link|reparse/);
    for (const path of [
      "../escape",
      "C:/escape",
      "\\\\server\\share",
      "file:stream",
      "NUL.txt",
      "COM¹.txt",
      "a/../b",
      "bad.",
      "bad ",
      ".env",
      ".git/config",
      ".FoRtIpI/state",
      "a\\b",
      "e\u0301",
    ])
      assert.throws(() => validateRelativePath(path), path);
  } finally {
    await f.cleanup();
  }
});
test("native shell preserves Unicode/metacharacters and scrubs synthetic credential/startup environment", async () => {
  const f = await fixture();
  const p = adapter();
  try {
    const result = join(f.path, "environment.json"),
      args = ["hello world", "λ雪", "a'b\"&;$()[]%!"];
    process.env.FORTIPI_EXECUTOR_SYNTHETIC_CANARY = "synthetic-canary";
    const child = p.spawn(
      p.shell(
        nodeCommand(fixtureChild, "environment", result, ...args),
        f.rootPath,
        childEnvironment(),
      ),
    );
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0);
    const value = JSON.parse(await readFile(result, "utf8")) as {
      canary: unknown;
      nodeOptions: unknown;
      systemRoot: unknown;
      args: string[];
    };
    assert.equal(value.canary, null);
    assert.equal(value.nodeOptions, null);
    assert.deepEqual(value.args, args);
    if (process.platform === "win32") assert.equal(typeof value.systemRoot, "string");
    assert.throws(() => childEnvironment({ NODE_OPTIONS: "--require ./bad" }), /unsafe/);
    assert.throws(() => childEnvironment({ PATH: "/attacker" }), /unsafe/);
  } finally {
    delete process.env.FORTIPI_EXECUTOR_SYNTHETIC_CANARY;
    await f.cleanup();
  }
});
test("actual child and grandchild stop writing after native process-tree cancellation", async () => {
  const f = await fixture(),
    p = adapter();
  let child: ReturnType<typeof p.spawn> | undefined;
  try {
    const marker = join(f.path, "heartbeats");
    child = p.spawn(
      p.shell(nodeCommand(fixtureChild, "tree", marker), f.rootPath, childEnvironment()),
    );
    await eventually(async () => {
      try {
        return (await stat(marker)).size > 0;
      } catch {
        return false;
      }
    }, "grandchild did not start");
    const disposition = await p.cancel(child, 200);
    assert.equal(disposition.state, "stopped");
    assert.equal(disposition.possibleExternalEffects, true);
    const before = (await stat(marker)).size;
    await new Promise<void>((r) => setTimeout(r, 180));
    assert.equal((await stat(marker)).size, before, "grandchild continued external writes");
    assert.equal(
      (await p.cancel(child, 50)).state,
      "unknown",
      "exited/recovered PID cannot authorize a new kill",
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await p.cancel(child, 50);
    await f.cleanup();
  }
});
test("native Unicode names, measured case behavior and a scheduled ancestor replacement preserve outside bytes", async () => {
  const f = await fixture();
  try {
    await f.root.write("café.txt", Buffer.from("unicode-name"), 493);
    const observed = await scan(f.root, defaults);
    assert.equal(observed.manifest.entries.find((e) => e.path === "café.txt")?.mode, 493);
    assert.equal((await f.root.read("café.txt", 100)).toString(), "unicode-name");
    if (f.root.identity.caseBehavior === "insensitive")
      assert.throws(
        () =>
          checkManifest(
            {
              version: 1,
              entries: [
                { path: "A/one", type: "directory", mode: 493 },
                { path: "a/two", type: "directory", mode: 493 },
              ],
            },
            defaults,
            f.root.identity.caseBehavior,
          ),
        /collision/,
      );
    const outside = join(f.path, "outside-directory");
    await mkdir(outside);
    await writeFile(join(outside, "victim"), "untouched");
    await f.root.mkdir("parent");
    await f.root.write("parent/victim", Buffer.from("inside"), 420);
    const original = f.root.recheck.bind(f.root);
    let replaced = false;
    f.root.recheck = async (chain) => {
      if (!replaced) {
        replaced = true;
        await rename(join(f.rootPath, "parent"), join(f.rootPath, "parked"));
        await symlink(
          outside,
          join(f.rootPath, "parent"),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      await original(chain);
    };
    await assert.rejects(
      f.root.write("parent/victim", Buffer.from("must-not-escape"), 420),
      /link|reparse|replaced/,
    );
    assert.equal(await readFile(join(outside, "victim"), "utf8"), "untouched");
  } finally {
    await f.cleanup();
  }
});
