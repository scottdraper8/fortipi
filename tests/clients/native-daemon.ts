import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import type { ExecutionIdentity, Job, Task } from "../../packages/fortipi-contract/dist/index.js";
import type { Profile } from "../../packages/fortipi-executor/dist/index.js";
import { nodeCommand } from "../../packages/fortipi-executor/test/fixtures/daemon.ts";
import { type CandidateReadContext, execute } from "../../scripts/prepare-release.ts";
import { object, REPOSITORY, REPOSITORY_ID, sha256 } from "../../scripts/verify-release-gates.ts";
import type { Installed } from "../distribution/install.ts";
import type { ScenarioEvidence } from "./evidence.ts";
import { observeNativeEvidenceFailure } from "./native-evidence-observation.ts";

async function observed<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    observeNativeEvidenceFailure(phase, error);
    throw error;
  }
}

interface DaemonService {
  endpoint: string;
  clientToken: string;
  profile: Profile;
  dispatch(command: string): Promise<{ jobId: string; taskId: string; approvalId: string }>;
  approve(id: string): Promise<void>;
  job(id: string): Promise<Job>;
  settled(id: string): Promise<Task>;
  cancelTask(id: string, requestId: string): Promise<void>;
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
function immutableAssignment(identity: ExecutionIdentity) {
  const { leaseVersion: _version, expiresAt: _expiry, ...lease } = identity.lease;
  return { ...identity, lease };
}
function assertLeaseObservation(
  previous: ExecutionIdentity["lease"],
  current: ExecutionIdentity["lease"],
  deadline: number,
): void {
  assert.ok(Number.isSafeInteger(deadline) && deadline > 0);
  for (const lease of [previous, current]) {
    assert.ok(Number.isSafeInteger(lease.leaseVersion) && lease.leaseVersion > 0);
    assert.ok(
      Number.isSafeInteger(lease.expiresAt) && lease.expiresAt > 0 && lease.expiresAt <= deadline,
    );
  }
  assert.ok(
    current.leaseVersion === previous.leaseVersion
      ? current.expiresAt === previous.expiresAt
      : current.leaseVersion > previous.leaseVersion && current.expiresAt >= previous.expiresAt,
  );
}
/** Trusted current native setup only. No caller-supplied "isolated" flag or
 * serialized receipt can enable use of the OS user's product registry. Hosted
 * VM freshness is an inference from the authenticated job/workflow plus the
 * provider contract; OS identity and absent/empty product state are observed. */
async function freshDarwinRunner(installed: Installed, context?: CandidateReadContext) {
  assert.ok(
    context?.kind === "current",
    "Darwin native evidence requires actual current Actions read context",
  );
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_JOB, "native");
  assert.equal(process.env.GITHUB_SERVER_URL, "https://github.com");
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(process.env.GITHUB_REPOSITORY_ID, String(REPOSITORY_ID));
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(
    process.env.GITHUB_WORKFLOW_REF,
    `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
  );
  assert.equal(installed.candidate.producer.workflowPath, ".github/workflows/release.yml");
  assert.equal(process.env.GITHUB_SHA, installed.candidate.sourceCommit);
  assert.equal(Number(process.env.GITHUB_RUN_ID), context.reference.runId);
  assert.equal(Number(process.env.GITHUB_RUN_ATTEMPT), context.reference.runAttempt);
  assert.equal(context.reference.candidateSha256, installed.hash);
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.RUNNER_OS, "macOS");
  assert.equal(process.env.RUNNER_ARCH, process.arch === "arm64" ? "ARM64" : "X64");
  const runnerName = process.env.RUNNER_NAME;
  assert.ok(
    runnerName && runnerName.length <= 256,
    "Trusted setup must receive nonsecret RUNNER_NAME",
  );
  const root = resolve(import.meta.dirname, "../..");
  const publicEnvironment = { PATH: process.env.PATH, LANG: "C.UTF-8" };
  const workflow = await promisify(execFile)(
    "git",
    ["show", `${installed.candidate.sourceCommit}:.github/workflows/release.yml`],
    { cwd: root, env: publicEnvironment, encoding: "buffer", timeout: 20000, maxBuffer: 262144 },
  );
  assert.equal(sha256(workflow.stdout), installed.candidate.producer.workflowSha256);
  const native = object(object(object(parseYaml(workflow.stdout.toString())).jobs).native);
  assert.equal(native.name, "native (${{ matrix.os }})");
  assert.equal(native["runs-on"], "${{ matrix.os }}");
  assert.equal(native.container, undefined);
  const matrix = object(object(native.strategy).matrix);
  assert.deepEqual(Object.keys(matrix), ["os"]);
  assert.deepEqual(matrix.os, ["ubuntu-24.04", "macos-15", "windows-2025"]);
  const jobs: Record<string, unknown>[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = object(
      await context.request(
        `/repos/${REPOSITORY}/actions/runs/${context.reference.runId}/attempts/${context.reference.runAttempt}/jobs?per_page=100&page=${page}`,
      ),
    );
    assert.ok(Array.isArray(response.jobs) && response.jobs.length <= 100);
    assert.ok(Number.isSafeInteger(response.total_count) && Number(response.total_count) <= 2000);
    jobs.push(...response.jobs.map(object));
    if (jobs.length >= Number(response.total_count)) {
      assert.equal(jobs.length, response.total_count);
      break;
    }
    assert.ok(response.jobs.length === 100 && page < 20, "Native job pagination is incomplete");
  }
  const matching = jobs.filter((job) => job.name === "native (macos-15)");
  assert.equal(matching.length, 1, "Actual current macos-15 native job must be unique");
  const job = matching[0];
  assert.ok(job);
  assert.equal(job.run_id, context.reference.runId);
  assert.equal(job.head_sha, installed.candidate.sourceCommit);
  assert.equal(job.status, "in_progress");
  assert.equal(job.conclusion, null);
  assert.equal(job.runner_name, runnerName);
  assert.ok(Number.isSafeInteger(job.id) && Number(job.id) > 0);
  assert.ok(Number.isSafeInteger(job.runner_id) && Number(job.runner_id) > 0);
  assert.ok(Array.isArray(job.labels) && job.labels.includes("macos-15"));
  assert.ok(
    !job.labels.some((label) => typeof label !== "string" || label.toLowerCase() === "self-hosted"),
  );
  const started = Date.parse(String(job.started_at));
  assert.ok(Number.isFinite(started) && started <= Date.now() && Date.now() - started < 45 * 60000);

  // Only now inspect fixed product paths. Never open a user's auth/profile
  // file, enumerate the home directory, clear old state or create an OS user.
  const systemVersion = "/usr/bin/sw_vers";
  const binary = await lstat(systemVersion);
  assert.ok(
    binary.isFile() && !binary.isSymbolicLink() && binary.uid === 0 && (binary.mode & 0o022) === 0,
  );
  const version = await promisify(execFile)(systemVersion, ["-productVersion"], {
    env: publicEnvironment,
    timeout: 10000,
    maxBuffer: 1024,
  });
  assert.match(version.stdout.trim(), /^15\.\d+(?:\.\d+)?$/);
  const user = userInfo();
  assert.ok(user.uid > 0 && process.getuid?.() === user.uid && process.geteuid?.() === user.uid);
  assert.ok(isAbsolute(user.homedir));
  assert.equal(homedir(), user.homedir);
  if (process.env.HOME !== undefined) assert.equal(process.env.HOME, user.homedir);
  assert.equal(await realpath(user.homedir), user.homedir);
  const home = await lstat(user.homedir);
  assert.ok(
    home.isDirectory() &&
      !home.isSymbolicLink() &&
      home.uid === user.uid &&
      (home.mode & 0o022) === 0,
  );
  let state: "absent" | "empty" = "absent";
  for (const path of [
    resolve(user.homedir, "Library"),
    resolve(user.homedir, "Library/Application Support"),
    resolve(user.homedir, "Library/Application Support/FortiPi"),
  ]) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) break;
    assert.ok(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === user.uid &&
        (stat.mode & 0o022) === 0,
    );
    assert.equal(await realpath(path), path);
    if (path.endsWith("/FortiPi")) {
      assert.equal(
        (await readdir(path)).length,
        0,
        "Existing FortiPi state prevents fresh-user qualification",
      );
      state = "empty";
    }
  }
  return {
    nativeJobId: job.id,
    runnerId: job.runner_id,
    label: "macos-15",
    macosVersion: version.stdout.trim(),
    osUid: user.uid,
    homeMatchesOsUserRecord: true,
    homeSha256: sha256(user.homedir),
    fortipiStateBeforeLoad: state,
    freshness: "inferred-from-authenticated-hosted-job-contract",
    actualHostedExecutionProof: "requires-retained-native-job-artifact",
  };
}
/** Actual installed CLI, new protected root/ledger, no copied node_modules or
 * prior ledger. Only this OS counts; cloud deployment and other OS jobs do not. */
export async function runNativeDaemon(
  installed: Installed,
  context?: CandidateReadContext,
): Promise<ScenarioEvidence> {
  const isolation =
    process.platform === "darwin"
      ? await observed("daemon-isolation", () => freshDarwinRunner(installed, context))
      : undefined;
  const module = (await observed(
    "daemon-installed-module",
    () =>
      import(
        pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-executor`))
          .href
      ),
  )) as typeof import("../../packages/fortipi-executor/dist/index.js");
  const source = (await observed(
    "daemon-service-module",
    () =>
      import(
        pathToFileURL(
          resolve(
            import.meta.dirname,
            "../../apps/worker/test/integration/native-daemon-service.ts",
          ),
        ).href
      ),
  )) as {
    nativeDaemonService(): Promise<DaemonService>;
  };
  const service = await observed("daemon-service-setup", () => source.nativeDaemonService()),
    platform = module.adapter();
  const directory = await observed("daemon-directory", async () =>
    realpath(await mkdtemp(resolve(tmpdir(), "fortipi-evidence-daemon-"))),
  );
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
  let phase = "daemon-protection";
  try {
    await platform.protect(directory, true);
    for (const path of [home, root, state]) {
      await mkdir(path, { mode: 0o700 });
      await platform.protect(path, true);
    }
    phase = "daemon-profile";
    const profile: Profile = {
      ...service.profile,
      ledgerId: `evidence_${randomUUID().replaceAll("-", "")}`,
      bindings: service.profile.bindings.map((binding) => ({ ...binding, path: root })),
      policy: { version: 1, trustedHost: false, requireConfinement: false, rules: [] },
      limits: { outputBytesPerJob: 4096, inlineTailBytes: 128, artifactBytes: 1024 },
    };
    await module.privateWrite(profilePath, JSON.stringify(profile));
    phase = "daemon-init";
    await command(["init"]);
    assert.equal((await status()).nativeEnabled, false);
    phase = "daemon-disclosure";
    // Actual CLI refuses to record host consent without its full disclosure.
    await command(["policy", "--trusted-host"], 1);
    assert.equal((await status()).nativeEnabled, false);
    await command(["policy", "--trusted-host", "--accept-daemon-user-files-and-network"]);
    assert.equal((await status()).nativeEnabled, true);
    phase = "daemon-start";
    startDaemon();
    await until(async () => {
      assert.equal(daemon?.exitCode, null, "Installed daemon exited before registration");
      return service.online();
    }, Boolean);
    const marker = resolve(directory, "starts"),
      nonce = randomUUID();
    const input = nodeCommand(
      resolve(import.meta.dirname, "fixtures/process-marker.ts"),
      marker,
      nonce,
      "output",
    );
    const refusedMarker = resolve(directory, "refused-starts");
    const refusedInput = nodeCommand(
      resolve(import.meta.dirname, "fixtures/process-marker.ts"),
      refusedMarker,
      randomUUID(),
      "output",
    );
    phase = "daemon-confinement-dispatch";
    const pending = await service.dispatch(refusedInput);
    phase = "daemon-confinement-remote-approval";
    await service.approve(pending.approvalId);
    phase = "daemon-confinement-local-approval";
    type Approval = { jobId: string; digest: string };
    const local = await until(
      async () => JSON.parse(await command(["approvals", "list"])) as Approval[],
      (rows) => rows.some((row) => row.jobId === pending.jobId),
    );
    const approval = local.find((row) => row.jobId === pending.jobId)!;
    assert.equal(await readFile(refusedMarker, "utf8").catch(() => ""), "");
    // Require confinement on the same real current assignment before approving.
    phase = "daemon-confinement-policy";
    const consent = await module.loadProfile(profilePath, platform, true);
    const assignmentBefore = await status();
    consent.policy = {
      ...consent.policy,
      version: consent.policy.version + 1,
      requireConfinement: true,
    };
    await module.privateWrite(profilePath, JSON.stringify(consent));
    await command(["approve", pending.jobId, "--digest", approval.digest]);
    phase = "daemon-confinement-refusal";
    const refusal = async () => {
      const ledger = await module.Ledger.open(
        resolve(state, profile.ledgerId),
        profile.ledgerId,
        module.effectiveLimits(profile.limits),
        platform,
      );
      try {
        const row = ledger.get(pending.jobId);
        return {
          state: row?.state,
          reason: row?.reason,
          identity: row?.assignment.identity,
          hasResult: !!row?.result,
        };
      } finally {
        ledger.close();
      }
    };
    const refused = await until(
      refusal,
      (row) => row.state === "closed" && !!row.reason?.includes("require-confinement"),
    );
    const refusedIdentity = refused.identity;
    assert.ok(refusedIdentity);
    assert.equal(refusedIdentity.jobId, pending.jobId);
    assert.equal(refused.hasResult, false);
    let observedRefusalLease = { ...refusedIdentity.lease };
    const assertRefusalRetained = async () => {
      const current = await refusal();
      assert.ok(current.identity);
      assert.deepEqual(
        { ...current, identity: immutableAssignment(current.identity) },
        { ...refused, identity: immutableAssignment(refusedIdentity) },
      );
      assertLeaseObservation(
        observedRefusalLease,
        current.identity.lease,
        refusedIdentity.deadline,
      );
      observedRefusalLease = { ...current.identity.lease };
      assert.equal(
        await readFile(refusedMarker, "utf8").catch(() => ""),
        "",
        "Required confinement cannot launch a native host process",
      );
    };
    await assertRefusalRetained();
    // Natural public disposition must precede parent-task cleanup.
    phase = "daemon-confinement-job";
    const rejected = await until(
      () => service.job(pending.jobId),
      (job) =>
        ["requires_reconciliation", "interrupted", "failed", "cancelled"].includes(job.state),
    );
    assert.equal(rejected.jobId, pending.jobId);
    assert.equal(rejected.taskId, pending.taskId);
    const publicAssignment = rejected.execution;
    assert.ok(publicAssignment);
    assert.deepEqual(immutableAssignment(publicAssignment), immutableAssignment(refusedIdentity));
    assertLeaseObservation(
      publicAssignment.lease,
      refusedIdentity.lease,
      publicAssignment.deadline,
    );
    if (rejected.state === "requires_reconciliation") {
      phase = "daemon-confinement-reconcile";
      await service.acknowledgeUnknown(pending.jobId);
    }
    phase = "daemon-confinement-cancel";
    const cancelRequestId = randomUUID();
    await service.cancelTask(pending.taskId, cancelRequestId);
    phase = "daemon-confinement-task";
    const settled = await service.settled(pending.taskId);
    assert.equal(settled.taskId, pending.taskId);
    phase = "daemon-confinement-job";
    const afterCleanup = await service.job(pending.jobId);
    assert.equal(afterCleanup.state, rejected.state);
    assert.deepEqual(afterCleanup.execution, publicAssignment);
    phase = "daemon-confinement-retention";
    await assertRefusalRetained();
    phase = "daemon-execution-policy";
    consent.policy = {
      ...consent.policy,
      version: consent.policy.version + 1,
      requireConfinement: false,
    };
    await module.privateWrite(profilePath, JSON.stringify(consent));
    phase = "daemon-confinement-retention";
    await assertRefusalRetained();
    phase = "daemon-execution-dispatch";
    const run = await service.dispatch(input);
    assert.notEqual(run.jobId, pending.jobId);
    assert.notEqual(run.taskId, pending.taskId);
    phase = "daemon-execution-remote-approval";
    await service.approve(run.approvalId);
    phase = "daemon-execution-local-approval";
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
    phase = "daemon-execution-marker";
    await until(
      async () => readFile(marker, "utf8").catch(() => ""),
      (value) => value === `${nonce}\n`,
    );
    phase = "daemon-execution-completion";
    const completed = await until(
      () => service.job(run.jobId),
      (job) => ["completed", "failed", "requires_reconciliation"].includes(job.state),
      60000,
    );
    assert.equal(completed.state, "completed");
    if (completed.state !== "completed") assert.fail("Actual installed daemon completion required");
    phase = "daemon-confinement-retention";
    await assertRefusalRetained();
    phase = "daemon-output";
    assert.equal(completed.preparedResult?.output.truncated, true);
    assert.ok(Buffer.byteLength(completed.preparedResult.output.tail) <= 128);
    const artifact = completed.preparedResult.output.artifacts.find(
      (item) => item.outputSource?.stream === "stdout",
    );
    assert.ok(artifact);
    assert.equal(artifact.size, 1024);
    phase = "daemon-artifact";
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
    phase = "daemon-duplicate";
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
    phase = "daemon-retained-ledger";
    const identity = completed.execution;
    assert.ok(identity);
    assert.notEqual(identity.executionId, refusedIdentity.executionId);
    const retained = async () => {
      const ledger = await module.Ledger.open(
        resolve(state, profile.ledgerId),
        profile.ledgerId,
        module.effectiveLimits(profile.limits),
        platform,
      );
      try {
        const row = ledger.get(run.jobId);
        return {
          executionId: row?.assignment.identity.executionId,
          committed: !!row?.committed,
          ledgerInstanceId: ledger.ledgerInstanceId,
        };
      } finally {
        ledger.close();
      }
    };
    await until(retained, (row) => row.committed && row.executionId === identity.executionId);
    const retainedInstanceId = (await retained()).ledgerInstanceId;
    phase = "daemon-abrupt-stop";
    await stopDaemon(true);
    phase = "daemon-offline";
    await until(
      () => service.online(),
      (value) => !value,
    );
    phase = "daemon-reopen";
    startDaemon();
    await until(() => service.online(), Boolean);
    assert.equal(daemon?.exitCode, null);
    phase = "daemon-reopen-retention";
    assert.deepEqual(await retained(), {
      executionId: identity.executionId,
      committed: true,
      ledgerInstanceId: retainedInstanceId,
    });
    const reopened = await service.job(run.jobId);
    assert.equal(reopened.state, "completed");
    assert.equal(reopened.execution?.executionId, identity.executionId);
    assert.equal(
      await readFile(marker, "utf8"),
      `${nonce}\n`,
      "Abrupt daemon reopen cannot repeat a committed native effect",
    );
    phase = "daemon-confinement-retention";
    await assertRefusalRetained();
    phase = "daemon-installed-integrity";
    await installed.verifyUnchanged();
    return {
      observation: {
        ...(isolation ? { isolation } : {}),
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
        ...(isolation
          ? [
              "Fresh hosted VM is inferred from the authenticated job/workflow and GitHub contract; actual OS/user and empty product paths are checked, without hardware attestation",
            ]
          : []),
      ],
    };
  } catch (error) {
    observeNativeEvidenceFailure(phase, error);
    throw error;
  } finally {
    await observed("daemon-cleanup-stop", () => stopDaemon());
    await observed("daemon-cleanup-service", () => service.close());
    await observed("daemon-cleanup-directory", () =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    );
  }
}
