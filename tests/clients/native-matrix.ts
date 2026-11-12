import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nodeCommand } from "../../packages/fortipi-executor/test/fixtures/daemon.ts";
import type { Installed } from "../distribution/install.ts";

async function until(read: () => Promise<boolean>, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await read()) return;
    await new Promise<void>((accept) => setTimeout(accept, 25));
  }
  throw new Error("Native observation deadline exceeded");
}
/** Actual installed public platform APIs, real native filesystem/SQLite/processes.
 * Full daemon dispatch/recovery is a separate required companion observation.
 */
export async function nativePlatform(installed: Installed) {
  const module = (await import(
    pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-executor`)).href
  )) as typeof import("../../packages/fortipi-executor/dist/index.js");
  return { ...(await nativePlatformPort(module)), installedPublicExecutor: true };
}
/** Same scenario also supports source engineering before real packs exist. */
export async function nativePlatformPort(
  module: typeof import("../../packages/fortipi-executor/dist/index.js"),
) {
  assert.ok(["darwin", "linux", "win32"].includes(process.platform));
  const platform = module.adapter();
  assert.equal(platform.platform, process.platform);
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-evidence-native-"));
  await platform.protect(directory, true);
  let processTree: ReturnType<typeof platform.spawn> | undefined;
  let stopDescendant: { path: string; nonce: string } | undefined;
  try {
    const rootA = resolve(directory, "A"),
      rootB = resolve(directory, "B"),
      outside = resolve(directory, "outside");
    for (const path of [rootA, rootB, outside]) {
      await mkdir(path, { mode: 0o700 });
      await platform.protect(path, true);
    }
    const a = await module.SafeRoot.open(rootA, platform),
      b = await module.SafeRoot.open(rootB, platform);
    assert.notEqual(a.key, b.key, "A and B must have distinct actual filesystem identities");
    const data = Buffer.from([0, 255, 13, 10, 128, 1]);
    await a.write("binary.bin", data, 420);
    assert.equal(
      createHash("sha256")
        .update(await a.read("binary.bin", 1024))
        .digest("hex"),
      createHash("sha256").update(data).digest("hex"),
    );
    await assert.rejects(b.read("binary.bin", 1024), "Fresh B cannot inherit A's disk");
    for (const path of ["../escape", ".ssh/id_rsa", "CON", "aux.txt", "file:stream"])
      assert.throws(() => a.native(path), "Reserved/escaping paths must reject before I/O");
    await writeFile(resolve(outside, "canary"), "outside-synthetic-canary");
    await symlink(
      outside,
      resolve(rootA, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      a.read("escape/canary", 1024),
      "Native symlink/junction escape must reject",
    );
    const guardPath = resolve(directory, "single-daemon.sqlite");
    const guard = await module.Guard.acquire(guardPath, platform);
    try {
      await assert.rejects(
        module.Guard.acquire(guardPath, platform),
        "Second actual SQLite daemon guard must fail",
      );
    } finally {
      guard.close();
    }
    const reopened = await module.Guard.acquire(guardPath, platform);
    reopened.close();
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" };
    if (process.platform === "win32") {
      assert.ok(process.env.SystemRoot);
      env.SystemRoot = process.env.SystemRoot;
    }
    const marker = resolve(directory, "process-starts"),
      nonce = randomUUID();
    stopDescendant = { path: `${marker}.child.stop`, nonce };
    const values = ["space value", "apostrophe'value", "semicolon;literal"];
    const script = resolve(import.meta.dirname, "fixtures/process-marker.ts");
    const spec = platform.shell(nodeCommand(script, marker, nonce, "tree", ...values), rootA, env);
    processTree = platform.spawn(spec);
    let stdout = "";
    processTree.stdout?.on("data", (bytes: Buffer) => {
      stdout += bytes.toString();
      assert.ok(stdout.length < 16384);
    });
    processTree.stderr?.resume();
    await until(async () => stdout.includes("\n"));
    const observed = JSON.parse(stdout.trim()) as {
      nonce: string;
      values: string[];
      descendant: number;
    };
    assert.equal(observed.nonce, nonce);
    assert.deepEqual(observed.values, values);
    await until(async () => {
      try {
        return JSON.parse(await readFile(`${marker}.child.ready`, "utf8")).nonce === nonce;
      } catch {
        return false;
      }
    });
    assert.equal(
      await readFile(marker, "utf8"),
      `${nonce}\n`,
      "External fsynced marker counts actual native starts",
    );
    const stopped = await platform.cancel(processTree, 100);
    assert.equal(
      stopped.state,
      "stopped",
      "Native tree cancellation must have an observed disposition",
    );
    await until(async () => {
      try {
        process.kill(observed.descendant, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }, 5000);
    processTree = undefined;
    const filesystem = await statfs(directory);
    return {
      publicExecutorPlatformApi: true,
      platform: process.platform,
      architecture: process.arch,
      kernel: release(),
      filesystemType: filesystem.type,
      actualCaseBehavior: a.identity.caseBehavior,
      permissionOrDaclVerified: true,
      distinctRoots: true,
      independentBinaryHash: true,
      reservedPathsRejected: true,
      linkEscapeRejected: true,
      actualSqliteSingleDaemonGuard: true,
      shellArgvPreserved: true,
      noUnrelatedRoleEnvironment: true,
      externalStartMarkers: 1,
      processTreeCancellation: stopped.state,
      limitation:
        "Platform portion only; daemon protocol/consent/output/dedup/recovery remains separately required",
    };
  } finally {
    if (processTree) await platform.cancel(processTree, 100);
    if (stopDescendant) await writeFile(stopDescendant.path, stopDescendant.nonce).catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
