import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  type Approval,
  canonicalJson,
  type Job,
  type ReconcileReceipt,
} from "../../packages/fortipi-contract/dist/index.js";
import { sha256 } from "../../scripts/verify-release-gates.ts";
import {
  assertLiveStart,
  type LiveReconciliationClient,
  liveExecutionProgram,
  verifyLiveReconciliation,
} from "./live-execution-controls.ts";

test("actual inline native observer records duplicate and failed command invocations without changing canonical input", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-live-command-")));
  try {
    const working = resolve(root, "workspace");
    await mkdir(working);
    const bytes = Buffer.from("independent-original-1010\n");
    await writeFile(resolve(working, "notes.txt"), bytes);
    await writeFile(resolve(root, "outside.txt"), bytes);
    const marker = resolve(root, "starts"),
      done = resolve(root, "done"),
      nonce = randomUUID();
    const workspace = {
      binding: {
        workspaceId: "controlled",
        bindingVersion: 1,
        config: { kind: "computer" as const },
        revision: "r0",
        manifestHash: sha256("fixture"),
        availability: "available" as const,
      },
      files: [{ path: "notes.txt", size: bytes.length, sha256: sha256(bytes) }],
    };
    const program = liveExecutionProgram({ marker, done, nonce, workspace, hold: false });
    const execute = (source = program) =>
      promisify(execFile)(process.execPath, ["-e", source], {
        cwd: working,
        timeout: 10000,
        maxBuffer: 65536,
        env: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      });
    assert.deepEqual(JSON.parse((await execute()).stdout), { nonce, unchanged: true });
    await assertLiveStart(marker, nonce);
    assert.equal(await readFile(done, "utf8"), `${nonce}\n`);
    await execute();
    assert.deepEqual(await readFile(resolve(working, "notes.txt")), bytes);
    await assert.rejects(() => assertLiveStart(marker, nonce), /Every command invocation/);
    assert.equal(await readFile(marker, "utf8"), `${nonce}\n${nonce}\n`);
    await writeFile(resolve(working, "notes.txt"), "tampered");
    await assert.rejects(() => execute());
    // Even failed preconditions must not hide a third physical invocation.
    assert.equal(await readFile(marker, "utf8"), `${nonce}\n`.repeat(3));
    assert.equal(await readFile(done, "utf8"), `${nonce}\n`.repeat(2));
    const outside = liveExecutionProgram({
      marker,
      done,
      nonce,
      workspace: {
        ...workspace,
        files: [{ path: "../outside.txt", size: bytes.length, sha256: sha256(bytes) }],
      },
      hold: false,
    });
    await assert.rejects(() => execute(outside));
    assert.equal(await readFile(marker, "utf8"), `${nonce}\n`.repeat(4));
    assert.equal(await readFile(done, "utf8"), `${nonce}\n`.repeat(2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type Behavior =
  | "valid"
  | "unsupported"
  | "old-identity-changed"
  | "fresh-assigned"
  | "foreign-target"
  | "changed-receipt";
class ProtocolFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super("controlled protocol outcome");
    this.status = status;
  }
}
function protocol(behavior: Behavior) {
  const original: Job = {
    jobId: "old-job",
    taskId: "old-task",
    agentId: "agent",
    conversationId: "conversation",
    workspaceId: "workspace",
    baseRevision: "r0",
    operationDigest: "1".repeat(64),
    version: 7,
    state: "requires_reconciliation",
    execution: {
      jobId: "old-job",
      executionId: "old-execution",
      operationDigest: "1".repeat(64),
      assignmentDigest: "2".repeat(64),
      target: { kind: "executor", executorId: "executor", generation: 1 },
      baseRevision: "r0",
      deadline: 900000,
      lease: {
        ownerKind: "job",
        jobId: "old-job",
        leaseId: "lease",
        operationId: "operation",
        credential: { credentialId: "synthetic-ref", generation: 1, grantVersion: 1 },
        registrationId: "registration",
        leaseVersion: 1,
        workspaceId: "workspace",
        executorId: "executor",
        executorGeneration: 1,
        fence: "1",
        baseRevision: "r0",
        expiresAt: 800000,
      },
    },
  };
  const originalApproval: Approval = {
    approvalId: "old-approval",
    jobId: original.jobId,
    agentId: original.agentId,
    conversationId: original.conversationId,
    requestingPrincipalId: "synthetic-principal",
    version: 1,
    state: "pending",
    operation: {
      operationId: "operation",
      operationDigest: original.operationDigest,
      tool: "shell",
      arguments: { command: "controlled-command" },
      workspaceId: "workspace",
      baseRevision: "r0",
      target: { kind: "executor", executorId: "executor", generation: 1 },
      trust: "host",
      capabilities: ["shell"],
      policyVersion: 1,
      grantVersion: 1,
      expiresAt: 900000,
    },
  };
  const current = structuredClone(original);
  const freshBase = structuredClone(original);
  delete freshBase.execution;
  const fresh: Job = {
    ...freshBase,
    jobId: "fresh-job",
    taskId: "fresh-task",
    operationDigest: "3".repeat(64),
    state: "awaiting_approval",
    version: 1,
  };
  if (behavior === "fresh-assigned") {
    assert.ok(original.execution);
    fresh.execution = structuredClone(original.execution);
  }
  const approval: Approval = {
    ...structuredClone(originalApproval),
    approvalId: "fresh-approval",
    jobId: fresh.jobId,
    operation: {
      ...structuredClone(originalApproval.operation),
      operationId: "fresh-operation",
      operationDigest: fresh.operationDigest,
    },
  };
  if (behavior === "foreign-target")
    approval.operation.target = { kind: "executor", executorId: "foreign", generation: 1 };
  const known = new Map<string, { input: string; receipt: ReconcileReceipt }>();
  let newRequests = 0,
    rejections = 0;
  const client: LiveReconciliationClient = {
    jobs: {
      async get(id) {
        assert.ok(id === original.jobId || id === fresh.jobId);
        return structuredClone(id === original.jobId ? current : fresh);
      },
      async reconcile(id, input) {
        assert.equal(id, original.jobId);
        const old = known.get(input.requestId),
          value = canonicalJson(input);
        if (old) {
          if (old.input !== value) throw new ProtocolFailure(409);
          return {
            ...old.receipt,
            ...(behavior === "changed-receipt" ? { operationId: "substituted" } : {}),
          };
        }
        if (input.expectedVersion !== current.version || input.action.kind === "acknowledge-failed")
          throw new ProtocolFailure(409);
        let receipt: ReconcileReceipt;
        if (input.action.kind === "acknowledge-unknown") {
          current.version++;
          receipt = {
            operationId: "ack",
            durableIntent: true,
            disposition: "unknown-acknowledged",
          };
          if (behavior === "old-identity-changed") current.operationDigest = "f".repeat(64);
        } else {
          assert.equal(input.action.kind, "new-job");
          if (behavior === "unsupported") throw new ProtocolFailure(501);
          newRequests++;
          current.version++;
          receipt = {
            operationId: "retry",
            durableIntent: true,
            disposition: "new-job-requested",
            newJobId: fresh.jobId,
          };
        }
        known.set(input.requestId, { input: value, receipt });
        return structuredClone(receipt);
      },
    },
    approvals: {
      async get(id) {
        assert.equal(id, approval.approvalId);
        return structuredClone(approval);
      },
      async decide(id, input) {
        assert.equal(id, approval.approvalId);
        assert.equal(input.operationDigest, fresh.operationDigest);
        assert.equal(input.expectedVersion, approval.version);
        assert.equal(input.decision, "reject");
        rejections++;
        fresh.state = "cancelled";
        return {
          ...structuredClone(approval),
          state: "rejected",
          decidedBy: "synthetic-principal",
          decidedAt: 1,
        };
      },
    },
  };
  return { client, original, originalApproval, counts: () => ({ newRequests, rejections }) };
}

test("public reconciliation oracle keeps unknown immutable and refuses unsupported, assigned, retargeted or non-idempotent retry outcomes", async () => {
  // Controlled DTO protocol only: no cloud, scheduler, SQLite, credential or
  // GateReceipt is fabricated or treated as actual deployed evidence.
  for (const behavior of [
    "valid",
    "unsupported",
    "old-identity-changed",
    "fresh-assigned",
    "foreign-target",
    "changed-receipt",
  ] as const) {
    const p = protocol(behavior);
    const run = () =>
      verifyLiveReconciliation({
        ...p,
        request: (operation) => operation(),
        conflict: async (operation) => {
          await assert.rejects(
            operation,
            (error) => error instanceof ProtocolFailure && error.status === 409,
          );
        },
        approvalFor: async (id) => {
          assert.equal(id, "fresh-job");
          return p.client.approvals.get("fresh-approval");
        },
      });
    if (behavior === "valid") {
      const observed = await run();
      assert.equal(observed.originalExecutionId, "old-execution");
      assert.equal(observed.newAuthorizedJobId, "fresh-job");
      assert.deepEqual(p.counts(), { newRequests: 1, rejections: 1 });
    } else await assert.rejects(run, behavior);
  }
});
