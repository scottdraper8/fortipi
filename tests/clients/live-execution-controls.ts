import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { FortiPiClient } from "../../packages/fortipi-client/dist/node.js";
import {
  type Approval,
  canonicalJson,
  type DurableEvent,
  type Job,
  type ReconcileInput,
  type ResourceScope,
} from "../../packages/fortipi-contract/dist/index.js";
import type { Profile } from "../../packages/fortipi-executor/dist/index.js";
import {
  assertDeployment,
  type DeploymentIdentity,
  sha256,
} from "../../scripts/verify-release-gates.ts";
import type { Installed } from "../distribution/install.ts";
import type { ScenarioEvidence } from "./evidence.ts";
import { deviceCanonicalBytes, deviceEventPrefix, deviceReadRequests } from "./live-device.ts";
import type { RecoveryWorkspaceCanary } from "./platform-recovery.ts";
import type { RoleContext } from "./roles.ts";

const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
const unchangedIdentity = (job: Job) => ({
  jobId: job.jobId,
  taskId: job.taskId,
  agentId: job.agentId,
  conversationId: job.conversationId,
  operationDigest: job.operationDigest,
  workspaceId: job.workspaceId,
  baseRevision: job.baseRevision,
  execution: job.execution,
  preparedResult: job.preparedResult,
  receipt: job.receipt,
});
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await delay(250);
  }
  throw new Error("Live execution public/native boundary was not observed before its deadline");
}

/** Inline independent OS observer; every command invocation appends/fsyncs, including
 * a repeated invocation. No exclusive marker can hide a duplicate attempt.
 * The held process has its own bounded natural exit after daemon loss. */
export function liveExecutionProgram(input: {
  marker: string;
  done: string;
  nonce: string;
  workspace: RecoveryWorkspaceCanary;
  hold: boolean;
}) {
  const code = `
    const a=require('node:assert/strict'),f=require('node:fs'),c=require('node:crypto'),p=require('node:path');
    const persist=(p,s)=>{const fd=f.openSync(p,'a',0o600);try{f.writeSync(fd,s);f.fsyncSync(fd)}finally{f.closeSync(fd)}};
    const line=${JSON.stringify(input.nonce + "\n")};persist(${JSON.stringify(input.marker)},line);
    a.ok(!Object.keys(process.env).some(k=>/TOKEN|SECRET|CLOUDFLARE|NPM_/i.test(k)));
    const root=f.realpathSync(process.cwd());
    for(const x of ${JSON.stringify(input.workspace.files)}) {
      a.ok(!p.isAbsolute(x.path));const path=p.resolve(root,x.path);
      a.ok(path.startsWith(root+p.sep));a.equal(f.realpathSync(path),path);
      const stat=f.lstatSync(path);a.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1);
      const b=f.readFileSync(path);a.equal(b.length,x.size);
      a.equal(c.createHash('sha256').update(b).digest('hex'),x.sha256);
    }
    const finish=()=>{persist(${JSON.stringify(input.done)},line);process.stdout.write(JSON.stringify({nonce:${JSON.stringify(input.nonce)},unchanged:true})+'\\n')};
    ${input.hold ? "setTimeout(finish,10000)" : "finish()"};
  `;
  return code;
}
export function liveExecutionCommand(input: Parameters<typeof liveExecutionProgram>[0]) {
  return `${quote(process.execPath)} -e ${quote(liveExecutionProgram(input))}`;
}
export async function assertLiveStart(path: string, nonce: string) {
  assert.equal(
    await readFile(path, "utf8"),
    `${nonce}\n`,
    "Every command invocation must append exactly one nonce",
  );
}

export type LiveReconciliationClient = {
  jobs: Pick<FortiPiClient["jobs"], "get" | "reconcile">;
  approvals: Pick<FortiPiClient["approvals"], "get" | "decide">;
};
/** Public DTO oracle, also exercised with controlled protocol outcomes. It
 * requires the public FreshJobs operation; unsupported is NOT a pass. */
export async function verifyLiveReconciliation(input: {
  client: LiveReconciliationClient;
  original: Job;
  originalApproval: Approval;
  request: ReturnType<typeof deviceReadRequests>;
  conflict: (operation: () => Promise<unknown>) => Promise<void>;
  approvalFor: (jobId: string) => Promise<Approval>;
}) {
  const { client, original, request, conflict } = input;
  assert.equal(original.state, "requires_reconciliation");
  assert.ok(original.execution);
  assert.equal(input.originalApproval.jobId, original.jobId);
  const before = unchangedIdentity(original);
  const ack: ReconcileInput = {
    requestId: randomUUID(),
    expectedVersion: original.version,
    reason: "seed1010 preserve the original unknown effects; never retry implicitly",
    action: { kind: "acknowledge-unknown" },
  };
  await conflict(() =>
    client.jobs.reconcile(original.jobId, { ...ack, expectedVersion: original.version + 1 }),
  );
  await conflict(() =>
    client.jobs.reconcile(original.jobId, {
      ...ack,
      requestId: randomUUID(),
      action: { kind: "acknowledge-failed" },
    }),
  );
  const receipt = await request(() => client.jobs.reconcile(original.jobId, ack));
  assert.equal(receipt.disposition, "unknown-acknowledged");
  assert.equal(receipt.durableIntent, true);
  assert.deepEqual(await request(() => client.jobs.reconcile(original.jobId, ack)), receipt);
  await conflict(() =>
    client.jobs.reconcile(original.jobId, {
      ...ack,
      reason: "changed intent under the same request",
    }),
  );
  const acknowledged = await request(() => client.jobs.get(original.jobId));
  assert.equal(acknowledged.state, original.state);
  assert.equal(acknowledged.version, original.version + 1);
  assert.deepEqual(unchangedIdentity(acknowledged), before);

  const retry: ReconcileInput = {
    requestId: randomUUID(),
    expectedVersion: acknowledged.version,
    reason: "seed1010 explicitly authorize a distinct job, still requiring fresh consent",
    action: { kind: "new-job", authorizationId: randomUUID() },
  };
  // Public routing handles this through FreshJobs before the generic
  // reconciliation handler. A new ordinary message is not a substitute.
  const requested = await request(() => client.jobs.reconcile(original.jobId, retry));
  assert.equal(requested.durableIntent, true);
  assert.equal(requested.disposition, "new-job-requested");
  assert.ok(requested.newJobId && requested.newJobId !== original.jobId);
  assert.deepEqual(await request(() => client.jobs.reconcile(original.jobId, retry)), requested);
  await conflict(() =>
    client.jobs.reconcile(original.jobId, {
      ...retry,
      requestId: randomUUID(),
      reason: "changed business authorization payload",
    }),
  );
  const newJobId = requested.newJobId;
  const fresh = await until(
    () => request(() => client.jobs.get(newJobId)),
    (job) => job.state === "awaiting_approval",
  );
  assert.equal(fresh.jobId, newJobId);
  assert.equal(fresh.agentId, original.agentId);
  assert.equal(fresh.conversationId, original.conversationId);
  assert.notEqual(fresh.taskId, original.taskId);
  assert.notEqual(fresh.operationDigest, original.operationDigest);
  assert.equal(fresh.execution, undefined);
  assert.equal(fresh.preparedResult, undefined);
  assert.equal(fresh.workspaceId, original.workspaceId);
  assert.equal(fresh.baseRevision, original.baseRevision);
  const approval = await input.approvalFor(newJobId);
  assert.equal(approval.state, "pending");
  assert.equal(approval.jobId, newJobId);
  assert.notEqual(approval.approvalId, input.originalApproval.approvalId);
  assert.equal(approval.agentId, original.agentId);
  assert.equal(approval.conversationId, original.conversationId);
  assert.notEqual(approval.operation.operationId, input.originalApproval.operation.operationId);
  assert.equal(approval.operation.operationDigest, fresh.operationDigest);
  assert.equal(approval.operation.tool, input.originalApproval.operation.tool);
  assert.deepEqual(approval.operation.arguments, input.originalApproval.operation.arguments);
  assert.deepEqual(approval.operation.target, input.originalApproval.operation.target);
  assert.equal(approval.operation.workspaceId, original.workspaceId);
  assert.equal(approval.operation.baseRevision, original.baseRevision);
  const rejected = await request(() =>
    client.approvals.decide(approval.approvalId, {
      requestId: randomUUID(),
      expectedVersion: approval.version,
      operationDigest: approval.operation.operationDigest,
      decision: "reject",
    }),
  );
  assert.equal(rejected.state, "rejected");
  const cancelled = await until(
    () => request(() => client.jobs.get(newJobId)),
    (job) => job.state === "cancelled",
  );
  assert.equal(cancelled.execution, undefined);
  assert.deepEqual(unchangedIdentity(cancelled), unchangedIdentity(fresh));
  const retained = await request(() => client.jobs.get(original.jobId));
  assert.equal(retained.state, original.state);
  assert.deepEqual(unchangedIdentity(retained), before);
  return {
    originalJobId: original.jobId,
    originalTaskId: original.taskId,
    originalExecutionId: original.execution.executionId,
    acknowledgment: receipt,
    originalUncertaintyRetained: true,
    newAuthorizedJobId: newJobId,
    newTaskId: fresh.taskId,
    freshApprovalId: approval.approvalId,
    freshApprovalRequired: true,
    newJobRejectedBeforeAssignment: true,
  };
}

/** One trusted application fixture shared by two claim methods. Only its scoped
 * executor profile enters the CLI; administrator/GH/CF/provider keys never do.
 * Linux has the supported XDG product registry boundary; no HOME substitution. */
export async function openLiveExecutionControls(input: {
  installed: Installed;
  roles: RoleContext;
  deployment: DeploymentIdentity;
  agentId: string;
  workspace: RecoveryWorkspaceCanary;
}) {
  assert.equal(
    process.platform,
    "linux",
    "Live installed execution controls require actual Linux/private XDG state",
  );
  const { installed, roles, deployment, workspace, agentId } = input;
  assertDeployment(deployment);
  assert.equal(new URL(roles.endpoint).protocol, "https:");
  assert.equal(roles.endpoint, deployment.origin);
  assert.equal(installed.hash, deployment.candidateSha256);
  assert.equal(installed.candidate.sourceCommit, deployment.sourceCommit);
  assert.equal(workspace.binding.config.kind, "computer");
  const configuration = await roles.call({
    operationId: "getConfiguration",
    path: {},
    query: {},
    body: undefined,
  });
  assert.equal(configuration.version, deployment.publicConfigurationVersion);
  assert.equal(sha256(canonicalJson(configuration)), deployment.runtimeConfigSha256);
  const conversation = await roles.call({
    operationId: "createConversation",
    path: { agentId },
    query: {},
    body: { requestId: randomUUID(), title: "seed1010-live-execution-controls" },
  });
  const executorId = randomUUID();
  const resources: ResourceScope = {
    agentIds: [agentId],
    conversationIds: [conversation.conversationId],
    workspaceIds: [workspace.binding.workspaceId],
    executorIds: [executorId],
    backendIds: [],
    tools: ["shell"],
    actions: [
      "tickets.mint",
      "conversations.read",
      "messages.submit",
      "events.read",
      "tasks.read",
      "jobs.read",
      "jobs.dispatch",
      "jobs.reconcile",
      "approvals.read",
      "approvals.decide",
      "executors.list",
      "workspace.read",
      "workspace.write",
      "workspaces.read",
    ],
  };
  const issued = await roles.issue({
    requestId: randomUUID(),
    role: "client",
    expiresAt: Date.now() + 20 * 60000,
    grants: [{ grantId: randomUUID(), version: 1, resources }],
  });
  const executorResources: ResourceScope = {
    ...resources,
    actions: [
      "tickets.mint",
      "executors.register",
      "transfers.input",
      "transfers.output",
      "transfers.status",
      "workspace.read",
      "workspace.write",
      "artifacts.read",
    ],
  };
  const executor = await roles.issue({
    requestId: randomUUID(),
    role: "executor",
    executorId,
    expiresAt: Date.now() + 20 * 60000,
    grants: [{ grantId: randomUUID(), version: 1, resources: executorResources }],
  });
  const sdk = (await import(
    pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/node`)).href
  )) as typeof import("../../packages/fortipi-client/dist/node.js");
  const native = (await import(
    pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-executor`)).href
  )) as typeof import("../../packages/fortipi-executor/dist/index.js");
  const client = new sdk.FortiPiClient({
    endpoint: roles.endpoint,
    credentials: async () => issued.token,
  });
  const request = deviceReadRequests();
  const protocol = await request(() => client.negotiate());
  const ticket = await request(() => client.tickets.mint(agentId, conversation.conversationId));
  assert.equal(ticket.identity.deploymentId, protocol.deploymentId);
  assert.equal(ticket.identity.role, "client");
  assert.deepEqual(ticket.identity.credential, issued.credential);
  await deviceCanonicalBytes(client, workspace, request);
  const bin = installed.bins["fortipi-executor"];
  assert.ok(bin);
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-live-controls-")));
  const root = resolve(directory, "workspace"),
    state = resolve(directory, "private");
  const profilePath = resolve(state, "executor.json");
  const platform = native.adapter();
  const environment = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    XDG_STATE_HOME: resolve(directory, "xdg-state"),
  };
  const events: DurableEvent[] = [];
  const nativeCommands: string[][] = [];
  const daemonExits: { requested: string; code: number | null; signal: NodeJS.Signals | null }[] =
    [];
  let daemon: ReturnType<typeof spawn> | undefined;
  let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let stream: ReturnType<FortiPiClient["conversations"]["subscribe"]> | undefined;
  const heldDone: { path: string; nonce: string }[] = [];
  let closed = false,
    dispatchPassed = false;
  async function command(args: string[], accepted = 0) {
    const sanitized = [process.execPath, bin!, ...args, "--profile", "<private-executor-profile>"];
    if (!nativeCommands.some((old) => canonicalJson(old) === canonicalJson(sanitized)))
      nativeCommands.push(sanitized);
    const child = spawn(process.execPath, [bin!, ...args, "--profile", profilePath], {
      cwd: directory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      length = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 65536) child.kill("SIGKILL");
      else stdout += chunk.toString();
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (accept, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => accept({ code, signal }));
        },
      );
      assert.equal(result.signal, null);
      assert.equal(result.code, accepted);
      assert.ok(length <= 65536);
      roles.assertSanitized(stdout);
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }
  async function localExecution(jobId: string, executionId: string) {
    const status: unknown = JSON.parse(await command(["status"]));
    assert.ok(
      status &&
        typeof status === "object" &&
        "executions" in status &&
        Array.isArray(status.executions),
    );
    const rows = status.executions.filter(
      (row: { jobId?: string; executionId?: string }) =>
        row?.jobId === jobId && row.executionId === executionId,
    );
    assert.equal(
      rows.length,
      1,
      "Installed CLI must retain exactly the original execution identity",
    );
    const row: unknown = rows[0];
    assert.ok(row && typeof row === "object" && "state" in row && typeof row.state === "string");
    return row.state;
  }
  async function stop(abrupt = false) {
    if (!daemon) return;
    const running = daemon.exitCode === null && daemon.signalCode === null;
    if (running) daemon.kill(abrupt ? "SIGKILL" : "SIGTERM");
    assert.ok(exit);
    const outcome = await Promise.race([
      exit,
      delay(15000, undefined, { ref: false }).then(() => {
        throw new Error("Installed live daemon exit unavailable");
      }),
    ]);
    daemonExits.push({ requested: abrupt ? "SIGKILL" : "SIGTERM", ...outcome });
    if (abrupt) {
      assert.ok(running);
      assert.equal(outcome.signal, "SIGKILL");
    } else assert.equal(outcome.code, 0);
    daemon = undefined;
  }
  async function start() {
    assert.equal(daemon, undefined);
    nativeCommands.push([
      process.execPath,
      bin!,
      "start",
      "--profile",
      "<private-executor-profile>",
    ]);
    daemon = spawn(process.execPath, [bin!, "start", "--profile", profilePath], {
      cwd: directory,
      env: environment,
      stdio: "ignore",
    });
    exit = new Promise((accept, reject) => {
      daemon!.once("error", reject);
      daemon!.once("close", (code, signal) => accept({ code, signal }));
    });
    void exit.catch(() => {});
  }
  async function conflict(operation: () => Promise<unknown>) {
    await assert.rejects(
      () => request(operation),
      (error) => error instanceof sdk.FortiPiError && error.status === 409,
    );
  }
  async function approvalFor(jobId: string) {
    const event = await until(
      async () =>
        events.find((event) => event.type === "approval.requested" && event.jobId === jobId),
      Boolean,
    );
    assert.ok(
      event &&
        event.payload &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload) &&
        "approvalId" in event.payload &&
        typeof event.payload.approvalId === "string",
    );
    const approvalId = event.payload.approvalId;
    return request(() => client.approvals.get(approvalId));
  }
  async function waitJob(jobId: string, state: Job["state"]) {
    await until(
      async () =>
        events.some(
          (event) =>
            event.type === "job.state.changed" &&
            event.jobId === jobId &&
            event.payload &&
            typeof event.payload === "object" &&
            "state" in event.payload &&
            event.payload.state === state,
        ),
      Boolean,
    );
    const job = await request(() => client.jobs.get(jobId));
    assert.equal(job.state, state);
    return job;
  }
  async function observedStart(path: string, nonce: string) {
    const value = await until(
      () =>
        readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        }),
      (value) => value.length > 0,
    );
    assert.ok(value.length > 0);
    await assertLiveStart(path, nonce);
  }
  async function submit(hold: boolean) {
    const marker = resolve(directory, `starts-${randomUUID()}`),
      done = `${marker}.done`,
      nonce = randomUUID();
    const shell = liveExecutionCommand({ marker, done, nonce, workspace, hold });
    const dispatch = {
      tool: "shell",
      arguments: { command: shell },
      workspaceId: workspace.binding.workspaceId,
      baseRevision: workspace.binding.revision,
      target: { kind: "executor", executorId, generation: 1 },
      capabilities: ["shell"],
    };
    const body = {
      clientRequestId: randomUUID(),
      busyBehavior: "followUp" as const,
      content: `Call fortipi_dispatch exactly once with these exact arguments: ${canonicalJson(dispatch)}. Wait for the human decision and completion. Then briefly report the disposition; do not invoke another tool.`,
    };
    const admissions = await Promise.all([
      request(() => client.conversations.send(conversation.conversationId, body)),
      request(() => client.conversations.send(conversation.conversationId, body)),
    ]);
    assert.deepEqual(admissions[0], admissions[1]);
    const admission = admissions[0];
    assert.ok(admission);
    const event = await until(
      async () =>
        events.find(
          (event) => event.type === "approval.requested" && event.taskId === admission.taskId,
        ),
      Boolean,
    );
    assert.ok(event?.jobId);
    const approval = await approvalFor(event.jobId);
    assert.equal(approval.state, "pending");
    assert.deepEqual(approval.operation.arguments, { command: shell });
    assert.deepEqual(approval.operation.target, dispatch.target);
    assert.equal(approval.operation.workspaceId, workspace.binding.workspaceId);
    assert.equal(approval.operation.baseRevision, workspace.binding.revision);
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    const decision = {
      requestId: randomUUID(),
      expectedVersion: approval.version,
      operationDigest: approval.operation.operationDigest,
      decision: "approve" as const,
    };
    const wrongDigest = `${decision.operationDigest[0] === "0" ? "1" : "0"}${decision.operationDigest.slice(1)}`;
    await conflict(() =>
      client.approvals.decide(approval.approvalId, { ...decision, operationDigest: wrongDigest }),
    );
    await conflict(() =>
      client.approvals.decide(approval.approvalId, {
        ...decision,
        requestId: randomUUID(),
        expectedVersion: approval.version + 1,
      }),
    );
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    const remote = await request(() => client.approvals.decide(approval.approvalId, decision));
    assert.equal(remote.state, "approved");
    const local = await until(async () => {
      const rows: unknown = JSON.parse(await command(["approvals", "list"]));
      assert.ok(Array.isArray(rows));
      return rows.find((row: { jobId?: string }) => row.jobId === approval.jobId) as
        | { jobId: string; digest: string; assignment: { identity: { executionId: string } } }
        | undefined;
    }, Boolean);
    assert.ok(
      local &&
        typeof local.digest === "string" &&
        typeof local.assignment.identity.executionId === "string",
    );
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    await command(["approve", approval.jobId, "--digest", `${local.digest}-wrong`], 1);
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    await command(["approve", approval.jobId, "--digest", local.digest]);
    if (hold) heldDone.push({ path: done, nonce });
    await observedStart(marker, nonce);
    return {
      marker,
      done,
      nonce,
      admission,
      body,
      approval,
      remoteApproval: remote,
      remoteDecision: decision,
      executionId: local.assignment.identity.executionId,
    };
  }
  function jobContext(job: Job, run: Awaited<ReturnType<typeof submit>>) {
    assert.equal(job.jobId, run.approval.jobId);
    assert.equal(job.taskId, run.admission.taskId);
    assert.equal(job.agentId, agentId);
    assert.equal(job.conversationId, conversation.conversationId);
    assert.equal(job.workspaceId, workspace.binding.workspaceId);
    assert.equal(job.baseRevision, workspace.binding.revision);
    assert.equal(job.operationDigest, run.approval.operation.operationDigest);
    assert.ok(job.execution);
    assert.equal(job.execution.executionId, run.executionId);
    assert.equal(job.execution.jobId, job.jobId);
    assert.equal(job.execution.baseRevision, job.baseRevision);
    assert.equal(job.execution.operationDigest, job.operationDigest);
    assert.deepEqual(job.execution.target, { kind: "executor", executorId, generation: 1 });
    assert.equal(job.execution.lease.ownerKind, "job");
    assert.equal(job.execution.lease.jobId, job.jobId);
    assert.equal(job.execution.lease.workspaceId, job.workspaceId);
    assert.equal(job.execution.lease.baseRevision, job.baseRevision);
  }
  async function close() {
    if (closed) return;
    closed = true;
    try {
      // A former daemon child may outlive SIGKILL, but its exact command has a
      // bounded natural finish. Never kill by a recovered/untrusted numeric PID.
      for (const done of heldDone) await observedStart(done.path, done.nonce);
      await installed.verifyUnchanged();
    } finally {
      try {
        await stop();
      } finally {
        stream?.close();
        await stream?.done.catch(() => {});
        try {
          const revocations = await Promise.allSettled(
            [executor, issued].map((role) => roles.revokeAndWait(role.credential.credentialId)),
          );
          assert.ok(
            revocations.every(
              (result) =>
                result.status === "fulfilled" &&
                result.value.state === "complete" &&
                result.value.pendingRecipients.length === 0,
            ),
            "Both execution-control roles must complete public revocation",
          );
        } finally {
          await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      }
    }
  }
  try {
    await platform.protect(directory, true);
    for (const path of [root, state]) {
      await mkdir(path, { mode: 0o700 });
      await platform.protect(path, true);
    }
    const profile: Profile = {
      version: 1,
      origin: roles.endpoint,
      deploymentId: protocol.deploymentId,
      executorId,
      executorGeneration: 1,
      credential: executor.credential,
      token: executor.token,
      ledgerId: `controls_${randomUUID().replaceAll("-", "")}`,
      bindings: [
        {
          rootBindingId: "control-root",
          path: root,
          workspaceId: workspace.binding.workspaceId,
          bindingVersion: workspace.binding.bindingVersion,
          revision: workspace.binding.revision,
          manifestHash: workspace.binding.manifestHash,
          providerKind: "computer",
        },
      ],
      resources: executorResources,
      policy: { version: 1, trustedHost: false, requireConfinement: false, rules: [] },
      limits: {},
    };
    await native.privateWrite(profilePath, JSON.stringify(profile), platform, true);
    await command(["init"]);
    await command(["policy", "--trusted-host", "--accept-daemon-user-files-and-network"]);
    stream = client.conversations.subscribe(conversation.conversationId, {
      agentId,
      maxReconnects: 0,
      onSnapshot() {},
      onEvent(event) {
        if (event.durability === "durable") events.push(structuredClone(event));
      },
    });
    await request(() => stream!.ready);
    await start();
    return {
      async dispatch(): Promise<ScenarioEvidence> {
        assert.ok(!closed && !dispatchPassed);
        const run = await submit(false);
        const job = await waitJob(run.approval.jobId, "completed");
        assert.equal(job.state, "completed");
        if (job.state !== "completed") throw new Error("Actual terminal native proof required");
        jobContext(job, run);
        assert.equal(job.preparedResult?.state, "succeeded");
        assert.equal(job.preparedResult?.identity.executionId, run.executionId);
        assert.equal(
          job.preparedResult?.identity.assignmentDigest,
          job.execution?.assignmentDigest,
        );
        assert.equal(job.preparedResult?.possibleExternalEffects, true);
        assert.equal(job.evidence.kind, "verified-unchanged");
        if (job.evidence.kind !== "verified-unchanged")
          throw new Error("Actual unchanged-base proof required");
        assert.equal(job.evidence.executionId, run.executionId);
        assert.equal(job.evidence.workspaceId, workspace.binding.workspaceId);
        assert.equal(job.evidence.baseRevision, workspace.binding.revision);
        assert.equal(job.evidence.manifestHash, workspace.binding.manifestHash);
        await until(
          async () =>
            events.some(
              (event) => event.type === "task.completed" && event.taskId === run.admission.taskId,
            ),
          Boolean,
        );
        assert.equal(
          (await request(() => client.tasks.get(run.admission.taskId))).status.state,
          "completed",
        );
        assert.deepEqual(
          await request(() => client.approvals.decide(run.approval.approvalId, run.remoteDecision)),
          run.remoteApproval,
        );
        await conflict(() =>
          client.approvals.decide(run.approval.approvalId, {
            ...run.remoteDecision,
            requestId: randomUUID(),
            expectedVersion: run.remoteApproval.version,
            decision: "reject",
          }),
        );
        await stop(true);
        await start();
        const retainedState = await localExecution(job.jobId, run.executionId);
        assert.ok(["result", "closed"].includes(retainedState));
        assert.deepEqual(await request(() => client.jobs.get(job.jobId)), job);
        assert.deepEqual(
          await request(() => client.conversations.send(conversation.conversationId, run.body)),
          run.admission,
        );
        await observedStart(run.marker, run.nonce);
        await deviceCanonicalBytes(client, workspace, request);
        assert.equal(
          events.filter(
            (event) => event.type === "approval.requested" && event.taskId === run.admission.taskId,
          ).length,
          1,
        );
        await installed.verifyUnchanged();
        dispatchPassed = true;
        const evidence: ScenarioEvidence = {
          observation: {
            jobId: job.jobId,
            taskId: job.taskId,
            executionId: run.executionId,
            admission: run.admission,
            remoteAndIndependentLocalConsent: true,
            wrongRemoteDigestAndVersionRejected: true,
            wrongLocalDigestRejected: true,
            originalRemoteDecisionRetainedAndConflictingDecisionRejected: true,
            starts: 1,
            markerSha256: sha256(await readFile(run.marker)),
            actualDaemonSigkillAndSameLedgerReopen: true,
            retainedLedgerState: retainedState,
            nativeCommands: structuredClone(nativeCommands),
            daemonExits: structuredClone(daemonExits),
            retainedEvidence: job.evidence,
            canonicalFiles: workspace.files,
          },
          oracle:
            "Concurrent original admission retries create one model-driven job; exact remote and native consent precede one fsynced start, actual unchanged-base proof and same-ledger daemon reopen retain the same task/execution without replay",
          sensitivity: [
            "Actual wrong remote digest/version and native digest reject before the external start",
            "Every physical start appends its nonce; a second invocation changes the independent marker",
          ],
          limitations: [
            "Actual deployed service plus current Linux installed executor required; source protocol checks alone cannot pass this claim",
            "Actual daemon-process loss/reopen only; server/DO reset, child-attachment fault windows, other native OS and separate-host effects remain companion proofs",
          ],
        };
        roles.assertSanitized(evidence);
        return evidence;
      },
      async reconciliation(): Promise<ScenarioEvidence> {
        assert.ok(
          dispatchPassed && !closed,
          "The same real fixture must first qualify normal native execution",
        );
        const commandStart = nativeCommands.length,
          exitStart = daemonExits.length;
        const run = await submit(true);
        // No network wait between fsynced start and kill: the held process must
        // lose its daemon before it can report a prepared result.
        await assert.rejects(lstat(run.done), { code: "ENOENT" });
        await stop(true);
        await observedStart(run.done, run.nonce);
        await start();
        const recoveredState = await until(
          () => localExecution(run.approval.jobId, run.executionId),
          (state) => state === "unknown",
        );
        const original = await waitJob(run.approval.jobId, "requires_reconciliation");
        jobContext(original, run);
        assert.equal(original.preparedResult, undefined);
        await until(
          async () =>
            events.some(
              (event) =>
                ["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(
                  event.type,
                ) && event.taskId === run.admission.taskId,
            ),
          Boolean,
        );
        const originalTask = await request(() => client.tasks.get(run.admission.taskId));
        assert.ok(["completed", "failed", "cancelled"].includes(originalTask.status.state));
        assert.equal(
          events.filter(
            (event) => event.type === "approval.requested" && event.taskId === run.admission.taskId,
          ).length,
          1,
          "Unknown effects cannot cause a second model dispatch under the original task",
        );
        const snapshot = await request(() => client.conversations.get(conversation.conversationId));
        const beforePrefix = await deviceEventPrefix(
          client,
          conversation.conversationId,
          snapshot.lastEventSeq,
          request,
        );
        const observation = await verifyLiveReconciliation({
          client,
          original,
          originalApproval: run.approval,
          request,
          conflict,
          approvalFor,
        });
        assert.equal(
          await deviceEventPrefix(
            client,
            conversation.conversationId,
            snapshot.lastEventSeq,
            request,
          ),
          beforePrefix,
        );
        await deviceCanonicalBytes(client, workspace, request);
        await observedStart(run.marker, run.nonce);
        assert.deepEqual(await request(() => client.tasks.get(run.admission.taskId)), originalTask);
        const evidence: ScenarioEvidence = {
          observation: {
            ...observation,
            starts: 1,
            markerSha256: sha256(await readFile(run.marker)),
            originalEventPrefixSha256: beforePrefix,
            canonicalFiles: workspace.files,
            actualDaemonLostAfterStart: true,
            recoveredLedgerState: recoveredState,
            nativeCommands: structuredClone(nativeCommands.slice(commandStart)),
            daemonExits: structuredClone(daemonExits.slice(exitStart)),
          },
          oracle:
            "Actual daemon loss after a durable native start retains unknown effects under the same job; public acknowledgment is idempotent, preserves original uncertainty/prefix/bytes, and an explicit new authorized job still requires its own rejected-before-assignment approval",
          sensitivity: [
            "Wrong reconcile version, relabeling unknown as failed, and changed acknowledgment under the same request reject",
            "Unsupported new-job, changed old identity/outcome or an assigned fresh retry blocks this claim",
          ],
          limitations: [
            "The external native effect remains real and unknown to the recovered daemon; no rollback or successful publication is fabricated",
            "Bounded child completion marker is observed; its OS exit is not independently witnessed after daemon loss, and no recovered PID is killed",
            "FreshJobs must actually return a new identity and fresh approval; unsupported responses or ordinary-message substitutes cannot pass",
          ],
        };
        roles.assertSanitized(evidence);
        return evidence;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
