import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Job, Task } from "../../packages/fortipi-contract/dist/index.js";
import type { Profile } from "../../packages/fortipi-executor/dist/index.js";
import { nodeCommand } from "../../packages/fortipi-executor/test/fixtures/daemon.ts";
import { execute } from "../../scripts/prepare-release.ts";
import type { Installed } from "../distribution/install.ts";
import type { ScenarioEvidence } from "./evidence.ts";

interface DaemonService {
  endpoint: string;
  clientToken: string;
  profile: Profile;
  dispatch(command: string): Promise<{ jobId: string; taskId: string; approvalId: string }>;
  approve(id: string): Promise<void>;
  job(id: string): Promise<Job>;
  settled(id: string): Promise<Task>;
  close(): Promise<void>;
  acknowledgeUnknown(id: string): Promise<void>;
  online(): Promise<boolean>;
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise<void>((accept) => setTimeout(accept, 50));
  }
  throw new Error("Installed daemon public observation deadline exceeded");
}
/** Actual installed CLI, new protected root/ledger, no copied node_modules or
 * prior ledger. Only this OS counts; cloud deployment and other OS jobs do not. */
export async function runNativeDaemon(installed: Installed): Promise<ScenarioEvidence> {
  assert.notEqual(
    process.platform,
    "darwin",
    "Actual isolated OS user or a supported private executor registry path is required: --profile does not relocate stateHome()/roots on Darwin; refuse before service setup, profile loading or registry access without overriding HOME",
  );
  const module = (await import(
    pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-executor`)).href
  )) as typeof import("../../packages/fortipi-executor/dist/index.js");
  const source = (await import(
    pathToFileURL(
      resolve(import.meta.dirname, "../../apps/worker/test/integration/native-daemon-service.ts"),
    ).href
  )) as {
    nativeDaemonService(): Promise<DaemonService>;
  };
  const service = await source.nativeDaemonService(),
    platform = module.adapter();
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-evidence-daemon-")));
  let daemon: ChildProcess | undefined, ended: Promise<number | null> | undefined;
  const home = resolve(directory, "home"),
    root = resolve(directory, "root"),
    state = resolve(directory, "state");
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    XDG_STATE_HOME: resolve(home, "state"),
    LOCALAPPDATA: resolve(home, "local"),
    APPDATA: resolve(home, "roaming"),
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const profilePath = resolve(state, "executor.json"),
    bin = installed.bins["fortipi-executor"];
  assert.ok(bin);
  async function command(args: string[], accepted = 0) {
    const result = await execute(
      process.execPath,
      [bin!, ...args, "--profile", profilePath, "--local-test"],
      directory,
      environment,
      30000,
    );
    assert.equal(result.timedOut, false);
    assert.equal(result.code, accepted, "Installed executor CLI command failed");
    assert.ok(!result.stdout.includes(service.profile.token));
    return result.stdout;
  }
  const status = async () =>
    JSON.parse(await command(["status"])) as {
      executorId: string;
      nativeEnabled: boolean;
      executions: { jobId: string; executionId: string; state: string }[];
    };
  const startDaemon = () => {
    assert.ok(!daemon);
    daemon = spawn(process.execPath, [bin!, "start", "--profile", profilePath, "--local-test"], {
      cwd: directory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    daemon.stdout?.resume();
    daemon.stderr?.resume();
    ended = new Promise((accept) => daemon!.once("close", (code) => accept(code)));
  };
  const stopDaemon = async (abrupt = false) => {
    if (!daemon) return;
    if (daemon.exitCode === null) daemon.kill(abrupt ? "SIGKILL" : "SIGTERM");
    await Promise.race([
      ended,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Installed daemon exit deadline exceeded")),
          10000,
        );
        timer.unref();
      }),
    ]);
    daemon = undefined;
  };
  try {
    await platform.protect(directory, true);
    for (const path of [home, root, state]) {
      await mkdir(path, { mode: 0o700 });
      await platform.protect(path, true);
    }
    const profile: Profile = {
      ...service.profile,
      ledgerId: `evidence_${randomUUID().replaceAll("-", "")}`,
      bindings: service.profile.bindings.map((binding) => ({ ...binding, path: root })),
      policy: { version: 1, trustedHost: false, requireConfinement: false, rules: [] },
      limits: { outputBytesPerJob: 4096, inlineTailBytes: 128, artifactBytes: 1024 },
    };
    await module.privateWrite(profilePath, JSON.stringify(profile));
    await command(["init"]);
    assert.equal((await status()).nativeEnabled, false);
    // Actual CLI refuses to record host consent without its full disclosure.
    await command(["policy", "--trusted-host"], 1);
    assert.equal((await status()).nativeEnabled, false);
    await command(["policy", "--trusted-host", "--accept-daemon-user-files-and-network"]);
    assert.equal((await status()).nativeEnabled, true);
    startDaemon();
    const marker = resolve(directory, "starts"),
      nonce = randomUUID();
    const input = nodeCommand(
      resolve(import.meta.dirname, "fixtures/process-marker.ts"),
      marker,
      nonce,
      "output",
    );
    const pending = await service.dispatch(input);
    await service.approve(pending.approvalId);
    type Approval = { jobId: string; digest: string };
    const local = await until(
      async () => JSON.parse(await command(["approvals", "list"])) as Approval[],
      (rows) => rows.some((row) => row.jobId === pending.jobId),
    );
    const approval = local.find((row) => row.jobId === pending.jobId)!;
    assert.equal(await readFile(marker, "utf8").catch(() => ""), "");
    // Require confinement on the same real current assignment before approving.
    const consent = await module.loadProfile(profilePath, platform, true);
    const assignmentBefore = await status();
    consent.policy = {
      ...consent.policy,
      version: consent.policy.version + 1,
      requireConfinement: true,
    };
    await module.privateWrite(profilePath, JSON.stringify(consent));
    await command(["approve", pending.jobId, "--digest", approval.digest]);
    await until(
      async () => {
        const ledger = await module.Ledger.open(
          resolve(state, profile.ledgerId),
          profile.ledgerId,
          module.effectiveLimits(profile.limits),
          platform,
        );
        try {
          const row = ledger.get(pending.jobId);
          return { state: row?.state, reason: row?.reason };
        } finally {
          ledger.close();
        }
      },
      (row) => row.state === "closed" && !!row.reason?.includes("require-confinement"),
    );
    assert.equal(
      await readFile(marker, "utf8").catch(() => ""),
      "",
      "Required confinement cannot launch a native host process",
    );
    const rejected = await until(
      () => service.job(pending.jobId),
      (job) =>
        ["requires_reconciliation", "interrupted", "failed", "cancelled"].includes(job.state),
    );
    if (rejected.state === "requires_reconciliation")
      await service.acknowledgeUnknown(pending.jobId);
    await service.settled(pending.taskId);
    consent.policy = {
      ...consent.policy,
      version: consent.policy.version + 1,
      requireConfinement: false,
    };
    await module.privateWrite(profilePath, JSON.stringify(consent));
    const run = await service.dispatch(input);
    await service.approve(run.approvalId);
    const waiting = await until(
      async () => JSON.parse(await command(["approvals", "list"])) as Approval[],
      (rows) => rows.some((row) => row.jobId === run.jobId),
    );
    await command([
      "approve",
      run.jobId,
      "--digest",
      waiting.find((row) => row.jobId === run.jobId)!.digest,
    ]);
    await until(
      async () => readFile(marker, "utf8").catch(() => ""),
      (value) => value === `${nonce}\n`,
    );
    const completed = await until(
      () => service.job(run.jobId),
      (job) => ["completed", "failed", "requires_reconciliation"].includes(job.state),
      60000,
    );
    assert.equal(completed.state, "completed");
    if (completed.state !== "completed") assert.fail("Actual installed daemon completion required");
    assert.equal(completed.preparedResult?.output.truncated, true);
    assert.ok(Buffer.byteLength(completed.preparedResult.output.tail) <= 128);
    const artifact = completed.preparedResult.output.artifacts.find(
      (item) => item.outputSource?.stream === "stdout",
    );
    assert.ok(artifact);
    assert.equal(artifact.size, 1024);
    const response = await fetch(`${service.endpoint}${artifact.endpoint}`, {
      headers: { Authorization: `Bearer ${service.clientToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 200);
    const actual = new Uint8Array(await response.arrayBuffer()),
      expected = Buffer.from("\u03bb".repeat(512));
    assert.equal(actual.byteLength, expected.byteLength);
    assert.equal(
      createHash("sha256").update(actual).digest("hex"),
      createHash("sha256").update(expected).digest("hex"),
    );
    const duplicate = await execute(
      process.execPath,
      [bin, "start", "--profile", profilePath, "--local-test"],
      directory,
      environment,
      10000,
    );
    assert.equal(duplicate.timedOut, false);
    assert.equal(
      duplicate.code,
      1,
      "Second installed daemon must reject its occupied protected ledger/root",
    );
    const identity = completed.execution;
    assert.ok(identity);
    const retained = async () => {
      const ledger = await module.Ledger.open(
        resolve(state, profile.ledgerId),
        profile.ledgerId,
        module.effectiveLimits(profile.limits),
        platform,
      );
      try {
        const row = ledger.get(run.jobId);
        return { executionId: row?.assignment.identity.executionId, committed: !!row?.committed };
      } finally {
        ledger.close();
      }
    };
    await until(retained, (row) => row.committed && row.executionId === identity.executionId);
    await stopDaemon(true);
    await until(
      () => service.online(),
      (value) => !value,
    );
    startDaemon();
    await until(() => service.online(), Boolean);
    assert.equal(daemon?.exitCode, null);
    assert.deepEqual(await retained(), { executionId: identity.executionId, committed: true });
    const reopened = await service.job(run.jobId);
    assert.equal(reopened.state, "completed");
    assert.equal(reopened.execution?.executionId, identity.executionId);
    assert.equal(
      await readFile(marker, "utf8"),
      `${nonce}\n`,
      "Abrupt daemon reopen cannot repeat a committed native effect",
    );
    await installed.verifyUnchanged();
    return {
      observation: {
        installedExecutorCli: true,
        platform: process.platform,
        freshRootAndLedger: true,
        explicitHostDisclosureRequired: true,
        requireConfinementRejectedBeforeStart: true,
        remoteAndLocalConsent: true,
        actualStarts: 1,
        sameExecutionAfterAbruptReopen: identity.executionId,
        singleDaemonRejected: true,
        outputTruncated: true,
        boundedTailBytes: Buffer.byteLength(completed.preparedResult.output.tail),
        artifactBytes: actual.byteLength,
        artifactSha256: createHash("sha256").update(actual).digest("hex"),
        priorAssignedCount: assignmentBefore.executions.length,
      },
      oracle:
        "Actual installed CLI requires explicit host and exact operation consent; confinement forbids native effects, output bytes are bounded/readable, and same-ledger reopen retains one external start",
      sensitivity: [
        "Real rejected CLI host disclosure and confinement requests with independent zero-start markers",
        "Concurrent duplicate installed daemon launch",
      ],
      limitations: [
        "Actual current native OS only; source local service/real Pi and Computer with synthetic model",
        "No separate live host, other native OS, paid cloud backend or platform eviction claim",
      ],
    };
  } finally {
    await stopDaemon();
    await service.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
