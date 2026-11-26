import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nodeCommand } from "../../packages/fortipi-executor/test/fixtures/daemon.ts";
import type { Installed } from "../distribution/install.ts";
import { observeNativeEvidenceFailure } from "./native-evidence-observation.ts";

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
  let module: typeof import("../../packages/fortipi-executor/dist/index.js");
  try {
    module = (await import(
      pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-executor`)).href
    )) as typeof import("../../packages/fortipi-executor/dist/index.js");
  } catch (error) {
    observeNativeEvidenceFailure("platform-installed-module", error);
    throw error;
  }
  return { ...(await nativePlatformPort(module)), installedPublicExecutor: true };
}
/** Same scenario also supports source engineering before real packs exist. */
export async function nativePlatformPort(
  module: typeof import("../../packages/fortipi-executor/dist/index.js"),
) {
  let phase = "platform-setup";
  try {
    assert.ok(["darwin", "linux", "win32"].includes(process.platform));
    const platform = module.adapter();
    assert.equal(platform.platform, process.platform);
    phase = "platform-directory";
    const directory = await mkdtemp(resolve(tmpdir(), "fortipi-evidence-native-"));
    phase = "platform-protection";
    await platform.protect(directory, true);
    let processTree: ReturnType<typeof platform.spawn> | undefined;
    let stopDescendant: { path: string; nonce: string } | undefined;
    let bodyFailed = false;
    let bodyFailurePhase = phase;
    try {
      phase = "platform-roots";
      const rootA = resolve(directory, "A"),
        rootB = resolve(directory, "B"),
        outside = resolve(directory, "outside");
      for (const path of [rootA, rootB, outside]) {
        await mkdir(path, { mode: 0o700 });
        await platform.protect(path, true);
      }
      phase = "platform-root-open";
      const a = await module.SafeRoot.open(rootA, platform),
        b = await module.SafeRoot.open(rootB, platform);
      phase = "platform-root-identity";
      assert.notEqual(a.key, b.key, "A and B must have distinct actual filesystem identities");
      phase = "platform-binary";
      const data = Buffer.from([0, 255, 13, 10, 128, 1]);
      await a.write("binary.bin", data, 420);
      assert.equal(
        createHash("sha256")
          .update(await a.read("binary.bin", 1024))
          .digest("hex"),
        createHash("sha256").update(data).digest("hex"),
      );
      phase = "platform-case";
      await a.write("Case-Probe", Buffer.from("first native spelling"), 420);
      const alias = await a.read("case-probe", 1024).catch(() => undefined);
      const caseManifest = {
        version: 1 as const,
        entries: ["Case-Probe", "case-probe"].map((path) => ({
          path,
          type: "file" as const,
          mode: 420 as const,
          size: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        })),
      };
      if (a.identity.caseBehavior === "insensitive") {
        assert.equal(Buffer.from(alias ?? []).toString(), "first native spelling");
        assert.throws(
          () => module.checkManifest(caseManifest, module.defaults, a.identity.caseBehavior),
          "A manifest must reject two names that alias on this actual native filesystem",
        );
      } else {
        assert.equal(alias, undefined);
        module.checkManifest(caseManifest, module.defaults, a.identity.caseBehavior);
        await a.write("case-probe", Buffer.from("second native spelling"), 420);
        assert.equal(
          Buffer.from(await a.read("Case-Probe", 1024)).toString(),
          "first native spelling",
        );
        assert.equal(
          Buffer.from(await a.read("case-probe", 1024)).toString(),
          "second native spelling",
        );
      }
      phase = "platform-root-isolation";
      await assert.rejects(b.read("binary.bin", 1024), "Fresh B cannot inherit A's disk");
      phase = "platform-reserved-paths";
      for (const path of ["../escape", ".ssh/id_rsa", "CON", "aux.txt", "file:stream"])
        assert.throws(() => a.native(path), "Reserved/escaping paths must reject before I/O");
      phase = "platform-link-escape";
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
      phase = "platform-sqlite-guard";
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
      phase = "platform-shell-environment";
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" };
      if (process.platform === "win32") {
        assert.ok(process.env.SystemRoot);
        env.SystemRoot = process.env.SystemRoot;
      }
      const marker = resolve(directory, "process-starts"),
        nonce = randomUUID();
      stopDescendant = { path: `${marker}.child.stop`, nonce };
      const values = ["space value", "apostrophe'value", "semicolon;literal"];
      phase = "platform-shell-spawn";
      const script = resolve(import.meta.dirname, "fixtures/process-marker.ts");
      const spec = platform.shell(
        nodeCommand(script, marker, nonce, "tree", ...values),
        rootA,
        env,
      );
      processTree = platform.spawn(spec);
      let stdout = "";
      processTree.stdout?.on("data", (bytes: Buffer) => {
        stdout += bytes.toString();
        assert.ok(stdout.length < 16384);
      });
      processTree.stderr?.resume();
      phase = "platform-shell-output";
      await until(async () => stdout.includes("\n"));
      const observed = JSON.parse(stdout.trim()) as {
        nonce: string;
        values: string[];
        descendant: number;
      };
      assert.equal(observed.nonce, nonce);
      assert.deepEqual(observed.values, values);
      phase = "platform-descendant-ready";
      await until(async () => {
        try {
          return JSON.parse(await readFile(`${marker}.child.ready`, "utf8")).nonce === nonce;
        } catch {
          return false;
        }
      });
      phase = "platform-start-marker";
      assert.equal(
        await readFile(marker, "utf8"),
        `${nonce}\n`,
        "External fsynced marker counts actual native starts",
      );
      phase = "platform-process-cancel";
      const stopped = await platform.cancel(processTree, 100);
      assert.equal(
        stopped.state,
        "stopped",
        "Native tree cancellation must have an observed disposition",
      );
      phase = "platform-descendant-exit";
      await until(async () => {
        try {
          process.kill(observed.descendant, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }, 5000);
      processTree = undefined;
      phase = "platform-filesystem";
      const filesystem = await statfs(directory);
      return {
        publicExecutorPlatformApi: true,
        platform: process.platform,
        architecture: process.arch,
        kernel: release(),
        filesystemType: filesystem.type,
        actualCaseBehavior: a.identity.caseBehavior,
        manifestCasePolicyMatchedActualFilesystem: true,
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
    } catch (error) {
      bodyFailed = true;
      bodyFailurePhase = phase;
      throw error;
    } finally {
      if (processTree) {
        phase = "platform-cleanup-stop";
        await platform.cancel(processTree, 100);
      }
      if (stopDescendant) {
        phase = "platform-cleanup-descendant";
        await writeFile(stopDescendant.path, stopDescendant.nonce).catch(() => {});
      }
      phase = "platform-cleanup-directory";
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      if (bodyFailed) phase = bodyFailurePhase;
    }
  } catch (error) {
    observeNativeEvidenceFailure(phase, error);
    throw error;
  }
}
