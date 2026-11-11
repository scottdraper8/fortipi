import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Assignment, LocalPrepare } from "fortipi-contract/executor";
import { assignmentDigest, operationDigest } from "fortipi-contract/executor";
import type { Profile } from "../../dist/config.js";
import { adapter, defaults, secureDirectory } from "../../dist/config.js";
import { Guard, Ledger } from "../../dist/ledger.js";
import type { LocalPolicy } from "../../dist/policy.js";
import type { HttpTransport } from "../../dist/transport.js";
import type { LocalWorkspace } from "../../dist/workspace/local.js";
import { scan } from "../../dist/workspace/manifest.js";
import { SafeRoot } from "../../dist/workspace/paths.js";

export const credential = {
  credentialId: "synthetic_client_credential",
  generation: 2,
  grantVersion: 3,
};
export const executorCredential = {
  credentialId: "synthetic_executor_transport",
  generation: 5,
  grantVersion: 1,
};
export const resources = {
  agentIds: ["agent"],
  conversationIds: ["conversation"],
  workspaceIds: ["workspace"],
  actions: [
    "workspace.read",
    "workspace.write",
    "executor.register",
    "executor.execute",
    "artifacts.read",
  ],
  tools: ["shell"],
  executorIds: ["executor"],
  backendIds: [],
};
export function policy(): LocalPolicy {
  return {
    version: 1,
    trustedHost: true,
    requireConfinement: false,
    consent: {
      acceptedAt: Date.now(),
      osUser: userInfo().username,
      disclosure: "daemon-user-files-and-network",
    },
    rules: [],
  };
}
export async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "fortipi-executor-")));
  const directory = join(path, "state"),
    rootPath = join(path, "root");
  await secureDirectory(directory);
  await secureDirectory(rootPath);
  const root = await SafeRoot.open(rootPath, adapter());
  const initial = await scan(root, defaults);
  const profile: Profile = {
    version: 1,
    origin: "http://127.0.0.1:8787",
    deploymentId: "deployment",
    executorId: "executor",
    executorGeneration: 7,
    credential: executorCredential,
    token: "synthetic-executor-token",
    ledgerId: "ledger",
    bindings: [
      {
        rootBindingId: "root",
        workspaceId: "workspace",
        bindingVersion: 1,
        path: rootPath,
        revision: "r0",
        manifestHash: initial.manifestHash,
        providerKind: "local",
      },
    ],
    resources,
    policy: policy(),
    limits: {},
  };
  const ledger = await Ledger.provision(directory, profile.ledgerId, defaults);
  return {
    path,
    directory,
    rootPath,
    root,
    profile,
    ledger,
    initial,
    async cleanup() {
      ledger.close();
      await rm(path, { recursive: true, force: true });
    },
  };
}
export const quote = (s: string) =>
  process.platform === "win32" ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", `'\\''`)}'`;
export function nodeCommand(...args: string[]): string {
  return `${process.platform === "win32" ? "& " : ""}${[process.execPath, ...args].map(quote).join(" ")}`;
}
export async function assignment(command: string, jobId = randomUUID()): Promise<Assignment> {
  const deadline = Date.now() + 60000,
    target = { kind: "executor" as const, executorId: "executor", generation: 7 };
  const operation = {
    deploymentId: "deployment",
    agentId: "agent",
    conversationId: "conversation",
    tool: "shell",
    arguments: { command },
    workspaceId: "workspace",
    baseRevision: "r0",
    target,
    policyVersion: 1,
    grantVersion: 3,
    deadline,
  };
  const operationHash = await operationDigest(operation),
    executionId = randomUUID(),
    reservationId = randomUUID(),
    leaseId = randomUUID(),
    operationId = randomUUID();
  const digest = await assignmentDigest({
    operation,
    executionId,
    reservationId,
    leaseId,
    fence: "1",
    executorGeneration: 7,
  });
  return {
    identity: {
      jobId,
      executionId,
      operationDigest: operationHash,
      assignmentDigest: digest,
      target,
      baseRevision: "r0",
      deadline,
      lease: {
        leaseId,
        operationId,
        credential,
        registrationId: "registration",
        leaseVersion: 1,
        workspaceId: "workspace",
        executorId: "executor",
        executorGeneration: 7,
        fence: "1",
        baseRevision: "r0",
        expiresAt: Date.now() + 30000,
        ownerKind: "job",
        jobId,
      },
    },
    reservationId,
    tool: "shell",
    arguments: { command },
    workspaceId: "workspace",
    bindingVersion: 1,
    rootBindingId: "root",
    operationContext: {
      deploymentId: "deployment",
      agentId: "agent",
      conversationId: "conversation",
      policyVersion: 1,
    },
    approval: {
      operationId,
      operationDigest: operationHash,
      tool: "shell",
      arguments: { command },
      workspaceId: "workspace",
      baseRevision: "r0",
      target,
      trust: "host",
      capabilities: ["shell"],
      policyVersion: 1,
      grantVersion: 3,
      expiresAt: deadline,
    },
  };
}
export function prepare(a: Assignment, manifestHash: string): LocalPrepare {
  return {
    kind: "prepare",
    operationId: a.identity.lease.operationId,
    operationDigest: a.identity.operationDigest,
    workspaceId: a.workspaceId,
    bindingVersion: 1,
    rootBindingId: "root",
    executorId: "executor",
    executorGeneration: 7,
    credential,
    baseRevision: "r0",
    lease: a.identity.lease,
    deadline: a.identity.deadline,
    commitId: randomUUID(),
    expectedManifestHash: manifestHash,
    mode: {
      kind: "native-execution",
      jobId: a.identity.jobId,
      executionId: a.identity.executionId,
      assignmentDigest: a.identity.assignmentDigest,
    },
  };
}
export function requestScope(request: LocalPrepare) {
  const { kind: _kind, mode: _mode, expectedManifestHash: _hash, ...scope } = request;
  return scope;
}
export function receiptScope(request: LocalPrepare) {
  const { commitId: _commit, ...scope } = requestScope(request);
  return scope;
}
export async function importRoot(local: LocalWorkspace): Promise<void> {
  if (!local.ledger.record("revisions", local.revisionKey(local.binding.revision)))
    await local.importBinding(local.importProposal(randomUUID()));
}
/** Synthetic trusted-CP state for local process tests; ticket/auth durability is excluded. */
export function authenticateFixture(http: HttpTransport): void {
  http.authority = {
    deploymentId: http.profile.deploymentId,
    principalId: "synthetic_executor_principal",
    role: "executor",
    credential: http.profile.credential,
    credentialExpiresAt: null,
  };
}
export async function eventually(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeout = 10000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise<void>((r) => setTimeout(r, 20));
  }
  throw new Error(message);
}
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === "guard") {
  try {
    const guard = await Guard.acquire(process.argv[3] as string);
    process.stdout.write("acquired\n");
    guard.close();
  } catch {
    process.stdout.write("locked\n");
    process.exitCode = 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === "claim-crash") {
  const directory = process.argv[3] as string;
  const ledger = await Ledger.open(directory, "ledger", defaults);
  const a = JSON.parse(process.argv[4] as string) as Assignment;
  const row = ledger.admit(a, "key");
  row.decision = "allow";
  ledger.put(row);
  if (!ledger.claim(a.identity.jobId, "key", "synthetic-root", a.identity.jobId))
    throw new Error("claim failed");
  process.exit(71);
}
export const fixtureChild = join(dirname(self), "child.ts");
if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === "start-crash") {
  const inputPath = process.argv[3] as string;
  const { privateRead } = await import("../../dist/config.js");
  const input = JSON.parse(await privateRead(inputPath)) as {
    profile: Profile;
    assignment: Assignment;
    directory: string;
    marker: string;
  };
  const guard = await Guard.acquire(join(input.directory, "daemon.guard.sqlite"));
  const ledger = await Ledger.open(input.directory, "ledger", defaults);
  const binding = input.profile.bindings[0];
  if (!binding) throw new Error("binding missing");
  const root = await SafeRoot.open(binding.path, adapter());
  const { ExecutorRuntime } = await import("../../dist/daemon.js"),
    { HttpTransport } = await import("../../dist/transport.js");
  const http = new HttpTransport(input.profile, fetch, true);
  authenticateFixture(http);
  const runtime = new ExecutorRuntime({
    profile: input.profile,
    ledger,
    directory: input.directory,
    roots: new Map([["root", root]]),
    http,
  });
  await runtime.initialize();
  runtime.connected = true;
  for (const local of runtime.locals.values()) await importRoot(local);
  await runtime.locals.get("root")?.request(prepare(input.assignment, binding.manifestHash));
  await runtime.assignOnce(input.assignment);
  const pending = runtime.approvals.list()[0];
  if (!pending) throw new Error("approval missing");
  runtime.approvals.decide(input.assignment.identity.jobId, pending.digest, "allow");
  await runtime.tick();
  await eventually(async () => {
    try {
      await realpath(input.marker);
      return true;
    } catch {
      return false;
    }
  }, "child marker missing");
  void guard;
  process.exit(77); // Abruptly release OS locks without daemon cleanup; test child self-exits shortly.
}
