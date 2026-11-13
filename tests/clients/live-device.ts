import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { FortiPiClient } from "../../packages/fortipi-client/dist/node.js";
import {
  type AdmissionReceipt,
  type CredentialRef,
  canonicalJson,
  type DurableEvent,
  type Lease,
  type Manifest,
  type ResourceScope,
  type UploadStatus,
} from "../../packages/fortipi-contract/dist/index.js";
import type { Profile } from "../../packages/fortipi-executor/dist/index.js";
import type { CandidateReadContext } from "../../scripts/prepare-release.ts";
import type { DeploymentIdentity } from "../../scripts/verify-release-gates.ts";
import type { Installed } from "../distribution/install.ts";
import type { ScenarioEvidence } from "./evidence.ts";
import type { RecoveryWorkspaceCanary } from "./platform-recovery.ts";
import type { IssuedRole, RoleContext } from "./roles.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Device = { executorId: string; generation: number };
/** Public fixture allocation. The trusted parent provisions these exact scopes;
 * it carries the SAME client token between jobs through its private channel.
 * No checkpoint can mint, recover or transport that credential. */
export interface DeviceContinuitySeed {
  agentId: string;
  conversationId: string;
  workspace: RecoveryWorkspaceCanary;
  a: Device;
  b: Device;
}
export function deviceResources(seed: DeviceContinuitySeed, executor?: Device): ResourceScope {
  return {
    agentIds: [seed.agentId],
    conversationIds: [seed.conversationId],
    workspaceIds: [seed.workspace.binding.workspaceId],
    executorIds: executor ? [executor.executorId] : [seed.a.executorId, seed.b.executorId],
    backendIds: [],
    tools: ["shell"],
    actions: executor
      ? [
          "tickets.mint",
          "executors.register",
          "transfers.input",
          "transfers.output",
          "transfers.status",
          "workspace.read",
          "workspace.write",
          "artifacts.read",
        ]
      : [
          "tickets.mint",
          "conversations.read",
          "messages.submit",
          "events.read",
          "tasks.read",
          "jobs.read",
          "jobs.dispatch",
          "approvals.read",
          "approvals.decide",
          "workspaces.read",
          "workspace.read",
          "workspace.write",
        ],
  };
}
/** These bytes retain the source deviceReplacement fixture's three-file/2MiB
 * payload. They are not a lowered Free deployment policy. */
export function deviceSeedBytes() {
  const multi = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < multi.length; i++) multi[i] = ((1010 & 255) + 31 * i) & 255;
  return {
    "notes.txt": Buffer.from("old-v1\n"),
    "binary.bin": Buffer.from("00ff0d0a8001", "hex"),
    "multi.bin": multi,
  };
}
function expectedFiles(note: string) {
  return Object.entries({ ...deviceSeedBytes(), "notes.txt": Buffer.from(`${note}\n`) })
    .map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
export interface DeviceHost {
  runId: number;
  runAttempt: number;
  jobId: number;
  runnerId: number;
  bootSha256: string;
}
export interface DeviceContinuityA {
  schemaVersion: 1;
  phase: "a";
  sourceCommit: string;
  candidateSha256: string;
  deploymentId: string;
  logicalApplicationId: string;
  workerVersionId: string;
  host: DeviceHost;
  agentId: string;
  conversationId: string;
  executor: Device;
  clientCredential: CredentialRef;
  initialWorkspace: RecoveryWorkspaceCanary;
  workspace: RecoveryWorkspaceCanary;
  requestId: string;
  promptSha256: string;
  admission: AdmissionReceipt;
  jobId: string;
  executionId: string;
  receiptSha256: string;
  oldLease: Extract<Lease, { ownerKind: "job" }>;
  eventThrough: number;
  eventPrefixSha256: string;
  localRootSha256: string;
  retirementId: string;
  revocationId: string;
}
export interface DevicePhaseInput {
  installed: Installed;
  context: CandidateReadContext;
  roles: RoleContext;
  deployment: DeploymentIdentity;
  seed: DeviceContinuitySeed;
  clientRole: IssuedRole;
  executorRole: IssuedRole;
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await delay(1000);
  }
  throw new Error("Separate-device public observation deadline exceeded");
}
/** Retry only an explicit public refusal. Unknown/transport failures propagate;
 * closures retain their original request IDs. No admission or effect replay. */
function requests() {
  const deadline = Date.now() + 10 * 60000;
  let refusals = 0;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        const p = error as {
          code?: string;
          status?: number;
          retryable?: boolean;
          retryAfterMs?: number;
          details?: { retryAfterMs?: number };
        };
        const wait = p.retryAfterMs ?? p.details?.retryAfterMs;
        if (
          p.code !== "rate_limited" ||
          p.status !== 429 ||
          p.retryable !== true ||
          !Number.isSafeInteger(wait) ||
          !wait ||
          wait < 1 ||
          wait > 60000 ||
          ++refusals > 8 ||
          Date.now() + wait > deadline
        )
          throw error;
        await delay(wait);
      }
    }
  };
}
/** This is an actual hosted Linux phase, not a caller-supplied isolation flag.
 * Two authenticated jobs/boot identities support VM replacement only; physical
 * host loss and provider runtime eviction remain unobserved. */
async function host(input: DevicePhaseInput, phase: "a" | "b"): Promise<DeviceHost> {
  assert.equal(process.platform, "linux", "This live phase currently requires actual Linux jobs");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_SERVER_URL, "https://github.com");
  assert.equal(process.env.GITHUB_REPOSITORY, "scottdraper8/fortipi");
  assert.equal(process.env.GITHUB_REPOSITORY_ID, "1453249080");
  assert.equal(process.env.GITHUB_SHA, input.installed.candidate.sourceCommit);
  assert.equal(process.env.GITHUB_JOB, `live-device-${phase}`);
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.RUNNER_OS, "Linux");
  assert.ok(process.env.RUNNER_NAME);
  assert.equal(input.context.reference.candidateSha256, input.installed.hash);
  const runId = Number(process.env.GITHUB_RUN_ID),
    runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  assert.ok(
    Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(runAttempt) && runAttempt > 0,
  );
  const jobs: Record<string, unknown>[] = [];
  for (let page = 1; page <= 20; page++) {
    const value = await input.context.request(
      `/repos/scottdraper8/fortipi/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
    );
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    const data = value as { jobs?: Record<string, unknown>[]; total_count?: number };
    assert.ok(
      Array.isArray(data.jobs) &&
        data.jobs.length <= 100 &&
        Number.isSafeInteger(data.total_count) &&
        Number(data.total_count) <= 2000,
    );
    jobs.push(...data.jobs);
    if (jobs.length === data.total_count) break;
    assert.ok(data.jobs.length === 100 && page < 20);
  }
  const selected = jobs.filter((job) => job.name === `live-device-${phase}`);
  assert.equal(selected.length, 1);
  const job = selected[0];
  assert.ok(job);
  assert.equal(job.run_id, runId);
  assert.equal(job.head_sha, input.installed.candidate.sourceCommit);
  assert.equal(job.status, "in_progress");
  assert.equal(job.conclusion, null);
  assert.equal(job.runner_name, process.env.RUNNER_NAME);
  assert.ok(
    Array.isArray(job.labels) &&
      job.labels.includes("ubuntu-24.04") &&
      !job.labels.includes("self-hosted"),
  );
  for (const id of [job.id, job.runner_id]) assert.ok(Number.isSafeInteger(id) && Number(id) > 0);
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  assert.match(boot, /^[0-9a-f-]{36}$/);
  return {
    runId,
    runAttempt,
    jobId: Number(job.id),
    runnerId: Number(job.runner_id),
    bootSha256: hash(boot),
  };
}
async function prefix(
  client: FortiPiClient,
  conversationId: string,
  through: number,
  request: ReturnType<typeof requests>,
) {
  const events: DurableEvent[] = [];
  assert.ok(Number.isSafeInteger(through) && through > 0 && through <= 1000);
  let after = 0;
  while (after < through) {
    const page = await request(() => client.conversations.events(conversationId, { after }));
    assert.ok(page.retainedFloor <= 1);
    const previous = after;
    for (const event of page.events.filter((e) => e.eventSeq <= through)) {
      assert.equal(event.eventSeq, after + 1);
      events.push(event);
      after = event.eventSeq;
    }
    assert.ok(after > previous && (after >= through || page.hasMore));
  }
  return hash(canonicalJson(events));
}
async function canonicalBytes(
  client: FortiPiClient,
  workspace: RecoveryWorkspaceCanary,
  request: ReturnType<typeof requests>,
) {
  const manifest = await request(() =>
    client.workspaces.manifest(workspace.binding.workspaceId, {
      revision: workspace.binding.revision,
    }),
  );
  assert.equal(manifest.manifestHash, workspace.binding.manifestHash);
  assert.equal(manifest.revision, workspace.binding.revision);
  assert.equal(manifest.workspaceId, workspace.binding.workspaceId);
  assert.deepEqual(
    manifest.manifest.entries
      .map((entry) => {
        assert.equal(entry.type, "file");
        return {
          path: entry.path,
          size: entry.type === "file" ? entry.size : -1,
          sha256: entry.type === "file" ? entry.sha256 : "",
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path)),
    workspace.files,
  );
  for (const file of workspace.files) {
    const bytes = await request(() =>
      client.workspaces.read(workspace.binding.workspaceId, {
        revision: workspace.binding.revision,
        path: file.path,
      }),
    );
    assert.equal(bytes.length, file.size);
    assert.equal(hash(bytes), file.sha256);
  }
}
/** Submit the REAL retained A job lease, with a fresh request/commit intent,
 * after B's successful commit. The carried client first opens a valid current
 * stage; this is not a stale-session mint. The refusal does not isolate expiry,
 * terminal reservation, credential mismatch or fencing as the rejecting guard. */
export async function rejectStaleDeviceLease(input: {
  writer: FortiPiClient;
  reader: FortiPiClient;
  oldLease: Extract<Lease, { ownerKind: "job" }>;
  previous: RecoveryWorkspaceCanary;
  current: RecoveryWorkspaceCanary;
  request: ReturnType<typeof requests>;
}) {
  const { writer, reader, oldLease, previous, current, request } = input;
  assert.equal(oldLease.ownerKind, "job");
  assert.equal(oldLease.workspaceId, previous.binding.workspaceId);
  assert.equal(current.binding.workspaceId, previous.binding.workspaceId);
  assert.notEqual(current.binding.revision, oldLease.baseRevision);
  await canonicalBytes(reader, current, request);
  assert.deepEqual(
    await request(() => reader.workspaces.get(current.binding.workspaceId)),
    current.binding,
  );
  const currentManifest = await request(() =>
    reader.workspaces.manifest(current.binding.workspaceId, { revision: current.binding.revision }),
  );
  assert.equal(currentManifest.manifestHash, current.binding.manifestHash);
  const positiveOperationId = randomUUID();
  const acquire = {
    requestId: randomUUID(),
    operationId: positiveOperationId,
    bindingVersion: current.binding.bindingVersion,
    baseRevision: current.binding.revision,
    deadline: Date.now() + 120000,
  };
  const positiveLease = await request(() =>
    writer.operations.acquireWorkspaceLease({
      path: { workspaceId: current.binding.workspaceId },
      query: {},
      body: acquire,
    }),
  );
  let positiveUploadId: string | undefined;
  let abortConfirmation: "acknowledged" | "reconciled-public-status" | undefined;
  const positiveBody = {
    requestId: randomUUID(),
    operationId: positiveOperationId,
    commitId: randomUUID(),
    lease: positiveLease,
    baseRevision: current.binding.revision,
    manifest: currentManifest.manifest,
    manifestHash: currentManifest.manifestHash,
    mutations: currentManifest.manifest.entries.map((entry) => {
      assert.equal(entry.type, "file");
      if (entry.type !== "file") throw new Error("Current device file manifest required");
      return {
        kind: "put" as const,
        path: entry.path,
        mode: entry.mode,
        size: entry.size,
        sha256: entry.sha256,
      };
    }),
  };
  try {
    const positive = await request(() =>
      writer.uploads.begin(current.binding.workspaceId, positiveBody),
    );
    positiveUploadId = positive.uploadId;
  } finally {
    try {
      if (positiveUploadId) {
        const uploadId = positiveUploadId;
        try {
          await request(() => writer.uploads.abort(current.binding.workspaceId, uploadId));
          abortConfirmation = "acknowledged";
        } catch {
          const status = await request(() =>
            writer.uploads.get(current.binding.workspaceId, uploadId),
          );
          assert.equal(status.uploadId, uploadId);
          assert.equal(
            status.state,
            "aborted",
            "An uncertain abort needs exact public status reconciliation",
          );
          abortConfirmation = "reconciled-public-status";
        }
      }
    } finally {
      const release = {
        requestId: randomUUID(),
        lease: positiveLease,
        reason: "cancelled" as const,
      };
      const released = await request(() =>
        writer.operations.releaseWorkspaceLease({
          path: { workspaceId: current.binding.workspaceId, leaseId: positiveLease.leaseId },
          query: {},
          body: release,
        }),
      );
      assert.equal(released.released, true);
      assert.equal(released.leaseId, positiveLease.leaseId);
    }
  }
  const retained = await request(() =>
    reader.workspaces.manifest(previous.binding.workspaceId, {
      revision: previous.binding.revision,
    }),
  );
  assert.equal(retained.workspaceId, previous.binding.workspaceId);
  assert.equal(retained.revision, previous.binding.revision);
  assert.equal(retained.manifestHash, previous.binding.manifestHash);
  const manifest: Manifest = retained.manifest;
  const body = {
    requestId: randomUUID(),
    operationId: oldLease.operationId,
    commitId: randomUUID(),
    baseRevision: oldLease.baseRevision,
    lease: oldLease,
    manifest,
    manifestHash: retained.manifestHash,
    mutations: manifest.entries.map((entry) => {
      assert.equal(entry.type, "file");
      if (entry.type !== "file") throw new Error("Original device file manifest required");
      return {
        kind: "put" as const,
        path: entry.path,
        mode: entry.mode,
        size: entry.size,
        sha256: entry.sha256,
      };
    }),
  };
  let refusal: { status: number; code: string } | undefined;
  let admitted: UploadStatus | undefined;
  try {
    admitted = await request(() => writer.uploads.begin(oldLease.workspaceId, body));
  } catch (error) {
    const observed = error as { status?: unknown; code?: unknown };
    assert.ok(
      (observed.status === 403 && observed.code === "unauthorized") ||
        (observed.status === 409 &&
          ["conflict", "workspace.conflict", "interrupted"].includes(String(observed.code))) ||
        (observed.status === 503 && observed.code === "unavailable_executor"),
      "A validated old-lease authority/conflict refusal is required; rate, schema, missing-route and transport failures do not qualify",
    );
    refusal = { status: Number(observed.status), code: String(observed.code) };
  }
  if (admitted) {
    try {
      await writer.uploads.abort(oldLease.workspaceId, admitted.uploadId);
    } catch {
      throw new Error(
        "Retained A lease admitted a new upload after B ownership; cleanup remains unacknowledged",
      );
    }
    throw new Error("Retained A lease admitted a new upload after B ownership");
  }
  assert.ok(refusal);
  assert.deepEqual(
    await request(() => reader.workspaces.get(current.binding.workspaceId)),
    current.binding,
  );
  await canonicalBytes(reader, current, request);
  await canonicalBytes(reader, previous, request);
  return {
    ...refusal,
    leaseId: oldLease.leaseId,
    operationId: oldLease.operationId,
    jobId: oldLease.jobId,
    fence: oldLease.fence,
    expiresAt: oldLease.expiresAt,
    originalBaseRevision: oldLease.baseRevision,
    currentRevision: current.binding.revision,
    positiveControl: {
      leaseId: positiveLease.leaseId,
      uploadId: positiveUploadId,
      aborted: true,
      abortConfirmation,
      released: true,
    },
    limitation:
      "Actual retained terminal A lease submitted under current B authority; expiry, terminal-state, credential and fence causes are not isolated",
  };
}
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
/** Exact command used by both actual installed executor phases. The external
 * start marker is created exclusively only AFTER every materialized base hash
 * matches. A changed file or repeated start must fail before a second effect. */
export function deviceWorkspaceCommand(
  marker: string,
  nonce: string,
  before: string,
  after: string,
) {
  const code = `
    const a = require('node:assert/strict'), f = require('node:fs'), c = require('node:crypto');
    a.ok(!Object.keys(process.env).some(k => /TOKEN|SECRET|CLOUDFLARE|NPM_/i.test(k)));
    const files = ${JSON.stringify(expectedFiles(before))};
    for (const x of files) {
      const b = f.readFileSync(x.path);
      a.equal(b.length, x.size);
      a.equal(c.createHash('sha256').update(b).digest('hex'), x.sha256);
    }
    const p = ${JSON.stringify(marker)}, n = ${JSON.stringify(nonce)}, nl = String.fromCharCode(10);
    const fd = f.openSync(p, 'ax', 0o600);
    try { f.writeFileSync(fd, n + nl); f.fsyncSync(fd); } finally { f.closeSync(fd); }
    const out = f.openSync('notes.txt', 'w');
    try { f.writeFileSync(out, ${JSON.stringify(after + String.fromCharCode(10))}); f.fsyncSync(out); }
    finally { f.closeSync(out); }
    process.stdout.write(JSON.stringify({ baseFiles: files, starts: 1 }) + nl);
  `;
  return `${shellQuote(process.execPath)} -e ${shellQuote(code)}`;
}

async function setup(input: DevicePhaseInput, phase: "a" | "b", base: RecoveryWorkspaceCanary) {
  const observedHost = await host(input, phase);
  assert.equal(new URL(input.roles.endpoint).protocol, "https:");
  assert.equal(input.roles.endpoint, input.deployment.origin);
  assert.notEqual(input.seed.a.executorId, input.seed.b.executorId);
  assert.equal(base.binding.config.kind, "computer");
  assert.equal(input.clientRole.role, "client");
  assert.equal(input.executorRole.role, "executor");
  for (const role of [input.clientRole, input.executorRole])
    assert.ok(role.expiresAt && role.expiresAt > Date.now() + 180000);
  const clientModule = (await import(
    pathToFileURL(
      input.installed.resolveExport(`@${input.installed.candidate.scope}/fortipi-client/node`),
    ).href
  )) as typeof import("../../packages/fortipi-client/dist/node.js");
  const executorModule = (await import(
    pathToFileURL(
      input.installed.resolveExport(`@${input.installed.candidate.scope}/fortipi-executor`),
    ).href
  )) as typeof import("../../packages/fortipi-executor/dist/index.js");
  const client = new clientModule.FortiPiClient({
    endpoint: input.roles.endpoint,
    credentials: async () => input.clientRole.token,
  });
  const request = requests();
  const identity = (
    await request(() => client.tickets.mint(input.seed.agentId, input.seed.conversationId))
  ).identity;
  assert.equal(identity.role, "client");
  const protocol = await request(() => client.negotiate());
  assert.equal(protocol.deploymentId, identity.deploymentId);
  const configuration = await input.roles.call({
    operationId: "getConfiguration",
    path: {},
    query: {},
    body: undefined,
  });
  assert.equal(configuration.version, input.deployment.publicConfigurationVersion);
  assert.equal(hash(canonicalJson(configuration)), input.deployment.runtimeConfigSha256);
  assert.deepEqual(protocol.infrastructure, configuration.infrastructure);
  assert.deepEqual(identity.credential, input.clientRole.credential);
  const projection = await request(() => client.conversations.get(input.seed.conversationId));
  assert.equal(projection.conversation.agentId, input.seed.agentId);
  assert.deepEqual(
    await request(() => client.workspaces.get(base.binding.workspaceId)),
    base.binding,
  );
  await canonicalBytes(client, base, request);
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-live-device-")));
  const root = resolve(directory, "workspace"),
    privateDirectory = resolve(directory, "private"),
    profilePath = resolve(privateDirectory, "executor.json");
  const platform = executorModule.adapter();
  try {
    await platform.protect(directory, true);
    for (const path of [root, privateDirectory]) {
      await mkdir(path, { mode: 0o700 });
      await platform.protect(path, true);
    }
    const device = input.seed[phase];
    const profile: Profile = {
      version: 1,
      origin: input.roles.endpoint,
      deploymentId: identity.deploymentId,
      executorId: device.executorId,
      executorGeneration: device.generation,
      credential: input.executorRole.credential,
      token: input.executorRole.token,
      ledgerId: `device_${randomUUID().replaceAll("-", "")}`,
      bindings: [
        {
          rootBindingId: "device-root",
          path: root,
          workspaceId: base.binding.workspaceId,
          bindingVersion: base.binding.bindingVersion,
          revision: base.binding.revision,
          manifestHash: base.binding.manifestHash,
          providerKind: "computer",
        },
      ],
      resources: deviceResources(input.seed, device),
      policy: { version: 1, trustedHost: false, requireConfinement: false, rules: [] },
      limits: {},
    };
    await executorModule.privateWrite(profilePath, JSON.stringify(profile), platform, true);
    const bin = input.installed.bins["fortipi-executor"];
    if (!bin) throw new Error("Actual installed executor bin is required");
    const executable: string = bin;
    // Linux's documented product state path keeps registry AND root/ledger/profile
    // inside this disposable tree. HOME is never set, redirected or inspected.
    const environment = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      XDG_STATE_HOME: resolve(directory, "xdg-state"),
    };
    async function command(args: string[]) {
      const child = spawn(process.execPath, [executable, ...args, "--profile", profilePath], {
        cwd: directory,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65536) child.kill("SIGKILL");
        else output += chunk.toString();
      });
      child.stderr.resume();
      try {
        await new Promise<void>((accept, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) =>
            code === 0 && signal === null && size <= 65536
              ? accept()
              : reject(new Error("Actual installed executor command failed")),
          );
        });
        input.roles.assertSanitized(output, [input.clientRole.token, input.executorRole.token]);
        return output;
      } finally {
        clearTimeout(timer);
      }
    }
    let daemon: ReturnType<typeof spawn> | undefined,
      exited: Promise<NodeJS.Signals | null> | undefined;
    let removal: Promise<void> | undefined;
    function destroy(): Promise<void> {
      removal ??= (async () => {
        try {
          if (daemon) {
            const running = daemon.exitCode === null && daemon.signalCode === null;
            if (running) daemon.kill("SIGKILL");
            const signal = await Promise.race([
              exited ?? Promise.reject(new Error("Daemon exit observer is absent")),
              delay(10000, undefined, { ref: false }).then(() => {
                throw new Error("Device daemon exit was not observed");
              }),
            ]);
            assert.ok(
              running && signal === "SIGKILL",
              "Device phase requires observed actual daemon loss",
            );
            daemon = undefined;
          }
        } finally {
          await rm(directory, { recursive: true });
          await assert.rejects(lstat(directory), { code: "ENOENT" });
        }
      })();
      return removal;
    }
    return {
      observedHost,
      client,
      request,
      directory,
      root,
      identity,
      command,
      async staleLease(original: DeviceContinuityA, current: RecoveryWorkspaceCanary) {
        return rejectStaleDeviceLease({
          writer: client,
          reader: client,
          oldLease: original.oldLease,
          previous: original.workspace,
          current,
          request,
        });
      },
      async start() {
        await command(["init"]);
        await command(["policy", "--trusted-host", "--accept-daemon-user-files-and-network"]);
        const child = spawn(process.execPath, [bin, "start", "--profile", profilePath], {
          cwd: directory,
          env: environment,
          stdio: ["ignore", "ignore", "ignore"],
        });
        daemon = child;
        exited = new Promise((accept, reject) => {
          child.once("error", reject);
          child.once("close", (_, signal) => accept(signal));
        });
        void exited.catch(() => {});
      },
      destroy,
      async assertRetiredSession() {
        const stale = new clientModule.FortiPiClient({
          endpoint: input.roles.endpoint,
          credentials: async () => input.executorRole.token,
        });
        const body = {
          requestId: randomUUID(),
          audience: "executor-session" as const,
          resources: deviceResources(input.seed, device),
          originMode: { kind: "native" as const },
          executor: device,
        };
        await assert.rejects(
          () => stale.execute({ operationId: "mintConnectionTicket", path: {}, query: {}, body }),
          (error: unknown) => error instanceof clientModule.FortiPiError && error.status === 409,
        );
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function executePhase(
  input: DevicePhaseInput,
  fixture: Awaited<ReturnType<typeof setup>>,
  before: string,
  after: string,
) {
  const { client, request } = fixture;
  const seen: DurableEvent[] = [];
  const subscription = client.conversations.subscribe(input.seed.conversationId, {
    agentId: input.seed.agentId,
    maxReconnects: 0,
    onSnapshot() {},
    onEvent(event) {
      if (event.durability === "durable") seen.push(structuredClone(event));
    },
  });
  const marker = resolve(fixture.directory, "starts");
  const nonce = randomUUID();
  const command = deviceWorkspaceCommand(marker, nonce, before, after);
  const base = await request(() => client.workspaces.get(input.seed.workspace.binding.workspaceId));
  const phase = before === "old-v1" ? "a" : "b";
  const target = { kind: "executor" as const, ...input.seed[phase] };
  // BackendRef spells executorGeneration as generation already in Device.
  const dispatch = {
    tool: "shell",
    arguments: { command },
    workspaceId: base.workspaceId,
    baseRevision: base.revision,
    target,
    capabilities: ["shell"],
  };
  const body = {
    clientRequestId: randomUUID(),
    busyBehavior: "followUp" as const,
    content: `Call fortipi_dispatch exactly once with these exact arguments: ${canonicalJson(dispatch)}. Wait for the human decision and completion. Then briefly confirm completion; do not call any further tool.`,
  };
  try {
    await request(async () => {
      await subscription.ready;
    });
    await fixture.start();
    const admission = await request(() =>
      client.conversations.send(input.seed.conversationId, body),
    );
    const approvalId = await until(async () => {
      const events = seen.filter(
        (e) => e.type === "approval.requested" && "taskId" in e && e.taskId === admission.taskId,
      );
      assert.ok(events.length <= 1, "The model must produce exactly the one requested job");
      if (!events.length) return undefined;
      const value = events[0]?.payload;
      assert.ok(
        value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          "approvalId" in value &&
          typeof value.approvalId === "string",
      );
      return value.approvalId;
    }, Boolean);
    assert.ok(approvalId);
    const approval = await request(() => client.approvals.get(approvalId));
    assert.equal(approval.state, "pending");
    assert.equal(approval.operation.tool, "shell");
    assert.deepEqual(approval.operation.arguments, { command });
    assert.deepEqual(approval.operation.target, target);
    assert.equal(approval.operation.workspaceId, base.workspaceId);
    assert.equal(approval.operation.baseRevision, base.revision);
    const decision = {
      requestId: randomUUID(),
      expectedVersion: approval.version,
      operationDigest: approval.operation.operationDigest,
      decision: "approve" as const,
    };
    await request(() => client.approvals.decide(approvalId, decision));
    const local = await until(async () => {
      const values: unknown = JSON.parse(await fixture.command(["approvals", "list"]));
      assert.ok(Array.isArray(values));
      return values.find(
        (v: { jobId?: unknown; digest?: unknown }) => v.jobId === approval.jobId,
      ) as { jobId: string; digest: string } | undefined;
    }, Boolean);
    assert.ok(local && typeof local.digest === "string");
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    await fixture.command(["approve", approval.jobId, "--digest", local.digest]);
    const job = await until(
      () => request(() => client.jobs.get(approval.jobId)),
      (value) =>
        [
          "completed",
          "failed",
          "cancelled",
          "interrupted",
          "requires_reconciliation",
          "workspace_conflict",
          "expired",
        ].includes(value.state),
    );
    assert.equal(job.taskId, admission.taskId);
    assert.equal(job.state, "completed");
    if (job.state !== "completed" || job.evidence.kind !== "committed")
      throw new Error("A real changed Computer commit is required");
    assert.ok(job.execution && job.preparedResult);
    assert.equal(job.workspaceId, base.workspaceId);
    assert.equal(job.baseRevision, base.revision);
    assert.equal(job.evidence.receipt.workspaceId, base.workspaceId);
    assert.equal(job.evidence.receipt.providerKind, "computer");
    assert.equal(job.evidence.receipt.jobId, job.jobId);
    assert.equal(job.evidence.receipt.baseRevision, base.revision);
    assert.equal(job.evidence.receipt.operationId, job.execution.lease.operationId);
    assert.equal(job.evidence.receipt.commitId, job.preparedResult.commitId);
    assert.equal(job.evidence.receipt.manifestHash, job.preparedResult.manifestHash);
    assert.equal(job.execution.jobId, job.jobId);
    assert.equal(job.execution.baseRevision, base.revision);
    assert.equal(job.execution.lease.ownerKind, "job");
    assert.equal(job.execution.lease.jobId, job.jobId);
    assert.equal(job.execution.lease.workspaceId, base.workspaceId);
    assert.equal(job.execution.lease.baseRevision, base.revision);
    assert.equal(job.execution.operationDigest, job.operationDigest);
    // Lease renewal version/expiry are observations, not new assignment IDs.
    assert.deepEqual({ ...job.preparedResult.identity, lease: job.execution.lease }, job.execution);
    const {
      leaseVersion: _preparedVersion,
      expiresAt: _preparedExpiry,
      ...preparedLease
    } = job.preparedResult.identity.lease;
    const {
      leaseVersion: _executionVersion,
      expiresAt: _executionExpiry,
      ...executionLease
    } = job.execution.lease;
    assert.deepEqual(preparedLease, executionLease);
    if (job.receipt) assert.deepEqual(job.receipt, job.evidence.receipt);
    assert.deepEqual(job.execution.target, target);
    assert.equal(job.preparedResult.output.truncated, false);
    const output: unknown = JSON.parse(job.preparedResult.output.tail.trim());
    assert.deepEqual(output, { baseFiles: expectedFiles(before), starts: 1 });
    assert.equal(await readFile(marker, "utf8"), `${nonce}\n`);
    await until(
      () => request(() => client.tasks.get(admission.taskId)),
      (task) => task.status.state === "completed",
    );
    assert.equal(
      seen.filter(
        (event) =>
          event.type === "approval.requested" &&
          "taskId" in event &&
          event.taskId === admission.taskId,
      ).length,
      1,
      "No second model dispatch is permitted",
    );
    const binding = await request(() => client.workspaces.get(base.workspaceId));
    assert.notEqual(binding.revision, base.revision);
    assert.equal(binding.manifestHash, job.evidence.receipt.manifestHash);
    assert.equal(binding.workspaceId, job.evidence.receipt.workspaceId);
    assert.equal(binding.revision, job.evidence.receipt.revision);
    assert.equal(binding.bindingVersion, base.bindingVersion);
    const workspace = { binding, files: expectedFiles(after) };
    await canonicalBytes(client, workspace, request);
    const snapshot = await request(() => client.conversations.get(input.seed.conversationId));
    return {
      workspace,
      admission,
      requestId: body.clientRequestId,
      promptSha256: hash(body.content),
      jobId: job.jobId,
      executionId: job.execution.executionId,
      receiptSha256: hash(canonicalJson(job.evidence.receipt)),
      oldLease: structuredClone(job.execution.lease),
      eventThrough: snapshot.lastEventSeq,
      eventPrefixSha256: await prefix(
        client,
        input.seed.conversationId,
        snapshot.lastEventSeq,
        request,
      ),
    };
  } finally {
    subscription.close();
    await subscription.done.catch(() => {});
  }
}
async function retire(input: DevicePhaseInput, device: Device) {
  const body = { requestId: randomUUID(), expectedGeneration: device.generation };
  const receipt = await until(
    () =>
      input.roles.call({
        operationId: "revokeExecutor",
        path: { id: device.executorId },
        query: {},
        body,
      }),
    (value) => value.state === "complete",
  );
  assert.equal(receipt.state, "complete");
  assert.equal(receipt.pendingRecipients.length, 0);
  return receipt;
}
/** Phase A returns only public facts after actual SIGKILL, observed exit, full
 * private-tree deletion and acknowledged public executor retirement. */
export async function runDeviceContinuityA(input: DevicePhaseInput): Promise<DeviceContinuityA> {
  assert.deepEqual(input.seed.workspace.files, expectedFiles("old-v1"));
  const fixture = await setup(input, "a", input.seed.workspace);
  try {
    const completed = await executePhase(input, fixture, "old-v1", "R1-on-A");
    await fixture.destroy();
    const retired = await retire(input, input.seed.a);
    await fixture.assertRetiredSession();
    const record: DeviceContinuityA = {
      schemaVersion: 1,
      phase: "a",
      sourceCommit: input.installed.candidate.sourceCommit,
      candidateSha256: input.installed.hash,
      deploymentId: input.deployment.deploymentId,
      logicalApplicationId: fixture.identity.deploymentId,
      workerVersionId: input.deployment.workerVersionId,
      host: fixture.observedHost,
      agentId: input.seed.agentId,
      conversationId: input.seed.conversationId,
      executor: input.seed.a,
      clientCredential: input.clientRole.credential,
      initialWorkspace: input.seed.workspace,
      ...completed,
      localRootSha256: hash(fixture.directory),
      retirementId: retired.operationId,
      revocationId: retired.revocationId,
    };
    input.roles.assertSanitized(record, [input.clientRole.token, input.executorRole.token]);
    await input.installed.verifyUnchanged();
    return record;
  } finally {
    await fixture.destroy();
  }
}
/** Trusted setup must authenticate A's source/run/artifact and exact checkpoint
 * bytes before supplying this DATA. No serialized flag authorizes archive reads,
 * role issuance or deployment. B independently rechecks every public fact. */
export async function runDeviceContinuityB(
  input: DevicePhaseInput,
  original: DeviceContinuityA,
): Promise<ScenarioEvidence> {
  assert.equal(original.schemaVersion, 1);
  assert.equal(original.phase, "a");
  assert.equal(original.sourceCommit, input.installed.candidate.sourceCommit);
  assert.equal(original.candidateSha256, input.installed.hash);
  assert.equal(original.deploymentId, input.deployment.deploymentId);
  assert.equal(original.workerVersionId, input.deployment.workerVersionId);
  assert.equal(original.agentId, input.seed.agentId);
  assert.equal(original.conversationId, input.seed.conversationId);
  assert.deepEqual(original.executor, input.seed.a);
  assert.deepEqual(
    original.clientCredential,
    input.clientRole.credential,
    "A new credential cannot retry A's principal-scoped admission",
  );
  assert.deepEqual(original.initialWorkspace, input.seed.workspace);
  assert.deepEqual(original.workspace.files, expectedFiles("R1-on-A"));
  const fixture = await setup(input, "b", original.workspace);
  try {
    assert.notEqual(fixture.observedHost.jobId, original.host.jobId);
    assert.notEqual(
      fixture.observedHost.bootSha256,
      original.host.bootSha256,
      "Two roots on one OS cannot claim separate hosts",
    );
    assert.notEqual(hash(fixture.directory), original.localRootSha256);
    assert.deepEqual(fixture.identity.credential, original.clientCredential);
    assert.equal(fixture.identity.deploymentId, original.logicalApplicationId);
    const { client, request } = fixture;
    const job = await request(() => client.jobs.get(original.jobId));
    assert.equal(job.taskId, original.admission.taskId);
    assert.equal(job.state, "completed");
    if (job.state !== "completed" || job.evidence.kind !== "committed")
      throw new Error("Original committed job must remain terminal");
    assert.equal(job.execution?.executionId, original.executionId);
    assert.equal(hash(canonicalJson(job.evidence.receipt)), original.receiptSha256);
    assert.equal(job.workspaceId, original.workspace.binding.workspaceId);
    assert.equal(job.evidence.receipt.workspaceId, original.workspace.binding.workspaceId);
    assert.equal(job.evidence.receipt.revision, original.workspace.binding.revision);
    assert.equal(job.evidence.receipt.manifestHash, original.workspace.binding.manifestHash);
    assert.equal(job.evidence.receipt.jobId, original.jobId);
    assert.equal(job.evidence.receipt.baseRevision, original.initialWorkspace.binding.revision);
    assert.equal(job.evidence.receipt.operationId, original.oldLease.operationId);
    assert.deepEqual(job.execution?.lease, original.oldLease);
    assert.equal(
      (await request(() => client.tasks.get(original.admission.taskId))).status.state,
      "completed",
    );
    assert.equal(
      await prefix(client, original.conversationId, original.eventThrough, request),
      original.eventPrefixSha256,
    );
    await canonicalBytes(client, original.initialWorkspace, request);
    // Recover content from its EXACT original public message ID, never a latest
    // task guess or checkpoint-supplied command. Same credential checked above.
    const projection = await request(() => client.conversations.get(original.conversationId));
    const message = projection.messages.find((m) => m.messageId === original.admission.messageId);
    assert.ok(message && message.role === "user");
    assert.equal(hash(message.content), original.promptSha256);
    const replay = {
      clientRequestId: original.requestId,
      content: message.content,
      busyBehavior: "followUp" as const,
    };
    assert.deepEqual(
      await request(() => client.conversations.send(original.conversationId, replay)),
      original.admission,
    );
    assert.equal(
      await prefix(client, original.conversationId, original.eventThrough, request),
      original.eventPrefixSha256,
    );
    const replacement = await executePhase(input, fixture, "R1-on-A", "R2-on-B");
    assert.notEqual(replacement.jobId, original.jobId);
    assert.notEqual(replacement.admission.taskId, original.admission.taskId);
    assert.notEqual(replacement.workspace.binding.revision, original.workspace.binding.revision);
    assert.equal(
      await prefix(client, original.conversationId, original.eventThrough, request),
      original.eventPrefixSha256,
    );
    await canonicalBytes(client, original.workspace, request);
    await canonicalBytes(client, original.initialWorkspace, request);
    assert.deepEqual(
      await request(() => client.jobs.get(original.jobId)),
      job,
      "Original completed effect is immutable",
    );
    const staleLease = await fixture.staleLease(original, replacement.workspace);
    await fixture.destroy();
    const retired = await retire(input, input.seed.b);
    await fixture.assertRetiredSession();
    await input.installed.verifyUnchanged();
    const result: ScenarioEvidence = {
      observation: {
        phase: "b",
        sourceCommit: input.installed.candidate.sourceCommit,
        candidateSha256: input.installed.hash,
        deploymentId: input.deployment.deploymentId,
        workerVersionId: input.deployment.workerVersionId,
        hosts: [original.host, fixture.observedHost],
        originalAdmission: original.admission,
        originalJobId: original.jobId,
        originalExecutionId: original.executionId,
        originalReceiptSha256: original.receiptSha256,
        originalEventPrefixSha256: original.eventPrefixSha256,
        originalWorkspace: original.workspace,
        replacement,
        staleLease,
        retirementId: retired.operationId,
        revocationId: retired.revocationId,
        originalStarts: 1,
        replacementStarts: 1,
        aRootAbsentBeforeB: true,
        bMaterializedOriginalHashes: true,
        physicalHostLoss: "not-observed",
      },
      oracle:
        "After A's observed daemon SIGKILL/full private-tree removal and public retirement, a distinct authenticated hosted OS job materializes all original Computer bytes; the same scoped principal retries the exact original admission without replaying its completed effect, then an explicit new job commits R2 while original receipt/events/R0/R1 remain intact",
      sensitivity: [
        "Different client credential, same OS boot, changed canonical file, changed original receipt/prefix or duplicate original effect cannot qualify",
      ],
      limitations: [
        "Linux hosted VM continuity only; no physical-host loss, provider eviction/runtime reset, interrupted-effect recovery or Paid backend proof",
        "Retained A lease refusal uses the same current write-authorized client after a successful B commit; terminal/expiry/credential/fence guards are not individually isolated",
        "Parent must authenticate both actual jobs and A artifact; this data record alone is not provenance or archive authority",
        "Two model-driven dispatches use the deployed model; source compilation/local roots cannot substitute for actual live observations",
      ],
    };
    input.roles.assertSanitized(result, [input.clientRole.token, input.executorRole.token]);
    return result;
  } finally {
    await fixture.destroy();
  }
}
