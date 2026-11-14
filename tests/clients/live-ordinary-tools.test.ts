import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  type Approval,
  type Configuration,
  type ConversationProjection,
  canonicalJson,
  type DurableEvent,
  type ExecutionIdentity,
  freeInfrastructurePolicy,
  type Job,
  type Message,
  schemaRefs,
  schemaRegistry,
} from "../../packages/fortipi-contract/dist/index.js";
import {
  applicableLiveClaims,
  integratedClaims,
  liveClaims,
  sha256,
} from "../../scripts/verify-release-gates.ts";
import {
  type OrdinaryToolsClient,
  ordinaryToolsPrompt,
  runOrdinaryTools,
} from "./live-ordinary-tools.ts";

type Mode =
  | "valid"
  | "no-context"
  | "assistant-context"
  | "no-job"
  | "wrong-target"
  | "missing-nonce"
  | "uncommitted-write"
  | "foreign-workspace";
const wire = new Ajv2020({ strict: true, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) wire.addSchema(schema);
function checked<T>(name: keyof typeof schemaRefs, value: T): T {
  assert.equal(
    wire.validate({ $ref: schemaRefs[name] }, value),
    true,
    `Controlled ${name} must obey the actual public schema`,
  );
  return value;
}

/** Controlled authenticated-public DTO substitutions, never a deployment/model
 * producer. Delay the projection beyond approval seeding to catch ordering assumptions. */
function protocol(mode: Mode = "valid") {
  const input = Buffer.from("ordinary-input:01234567-89ab-cdef-0123-456789abcdef\n"),
    expected = Buffer.concat([input, Buffer.from("ordinary-tools-verified\n")]),
    binary = Buffer.from([0, 255, 13]);
  const hash = sha256("manifest"),
    changedHash = sha256("changed-manifest");
  const target = { kind: "executor" as const, executorId: "native-a", generation: 7 };
  const configuration: Configuration = {
    version: 3,
    workspace: { kind: "computer" },
    execution: { kind: "native", executorId: target.executorId, trust: "host" },
    routing: { kind: "prefer-local", targetIds: [] },
    models: [{ providerId: "cloudflare", modelId: "controlled-only" }],
    infrastructure: structuredClone(freeInfrastructurePolicy),
  };
  const workspace = {
    binding: {
      workspaceId: "computer",
      bindingVersion: 1,
      revision: "r0",
      manifestHash: hash,
      config: { kind: "computer" as const },
      availability: "available" as const,
    },
    files: [
      { path: "binary.bin", size: binary.length, sha256: sha256(binary) },
      { path: "notes.txt", size: input.length, sha256: sha256(input) },
    ],
  };
  const admission = {
    operationId: "input-operation",
    taskId: "root-task",
    messageId: "user-message",
    revision: "c1",
    eventSeq: 2,
  };
  const context = {
    routing: configuration.routing,
    argumentContracts: { "native-shell": 'shell arguments: {"command": string}' },
    targets: [
      { target, platform: "linux", capabilities: ["shell"], argumentFormat: "native-shell" },
    ],
    workspaces: [
      {
        workspaceId: "computer",
        bindingVersion: 1,
        configured: true,
        provider: "computer",
        baseRevision: "r0",
        targets: [target],
      },
    ],
  };
  const approval: Approval = {
    approvalId: "approval",
    jobId: "job",
    agentId: "agent",
    conversationId: "fresh",
    requestingPrincipalId: "scoped-client",
    version: 1,
    state: "pending",
    operation: {
      operationId: "tool-operation",
      operationDigest: sha256("operation"),
      tool: "shell",
      arguments: { command: "printf 'ordinary-tools-verified\\n' >> notes.txt; cat notes.txt" },
      workspaceId: "computer",
      baseRevision: "r0",
      target,
      trust: "host",
      capabilities: ["shell"],
      policyVersion: 1,
      grantVersion: 1,
      expiresAt: Date.now() + 120000,
    },
  };
  const receipt = {
    commitId: "commit",
    operationId: "tool-operation",
    workspaceId: "computer",
    commitDigest: sha256("commit"),
    baseRevision: "r0",
    revision: "r1",
    manifestHash: changedHash,
    sourceFactId: "workspace-fact",
    committedAt: Date.now(),
    providerKind: "computer" as const,
    storeRef: { stageId: "sealed-stage" },
  };
  const execution: ExecutionIdentity = {
    jobId: "job",
    executionId: "execution",
    assignmentDigest: sha256("assignment"),
    operationDigest: approval.operation.operationDigest,
    deadline: Date.now() + 120000,
    baseRevision: "r0",
    target,
    lease: {
      ownerKind: "job" as const,
      leaseId: "lease",
      jobId: "job",
      operationId: "tool-operation",
      workspaceId: "computer",
      credential: { credentialId: "scoped-client", generation: 1, grantVersion: 1 },
      registrationId: "registered-client",
      executorId: target.executorId,
      executorGeneration: target.generation,
      baseRevision: "r0",
      fence: "1",
      expiresAt: Date.now() + 120000,
      leaseVersion: 1,
    },
  };
  checked("Configuration", configuration);
  checked("Approval", approval);
  checked("ExecutionIdentity", execution);
  checked("CommitReceipt", receipt);
  const waiting: Job = {
    jobId: "job",
    taskId: "root-task",
    agentId: "agent",
    conversationId: "fresh",
    operationDigest: approval.operation.operationDigest,
    workspaceId: "computer",
    baseRevision: "r0",
    version: 1,
    state: "awaiting_approval",
  };
  const events: DurableEvent[] = [];
  function event(type: string, payload: unknown, jobId?: string) {
    const value = {
      protocolVersion: "1.0" as const,
      schemaVersion: "1.0.0" as const,
      deploymentId: "logical-app",
      conversationId: "fresh",
      eventId: `event-${events.length + 1}`,
      timestamp: Date.now(),
      durability: "durable" as const,
      eventSeq: events.length + 1,
      ...(jobId
        ? { jobId, taskId: "root-task" }
        : type.startsWith("task.")
          ? { taskId: "root-task" }
          : {}),
      type,
      payload: JSON.parse(canonicalJson(payload)),
    };
    events.push(value);
  }
  let submitted = false,
    consent = 0,
    remote = 0,
    snapshots = 0;
  let job: Job = waiting;
  const messages: Message[] = [];
  const current = { ...workspace.binding, revision: "r1", manifestHash: changedHash };
  const client: OrdinaryToolsClient = {
    conversations: {
      async get() {
        if (
          submitted &&
          ++snapshots >= 2 &&
          !messages.some((m) => m.messageId === "context-result")
        ) {
          if (mode !== "no-context") {
            const message: Message = {
              messageId: "context-result",
              role: mode === "assistant-context" ? "assistant" : "tool",
              content: JSON.stringify(context),
              timestamp: Date.now(),
            };
            messages.push(message);
            event("message.committed", message);
          }
        }
        const projection: ConversationProjection = {
          conversation: {
            conversationId: "fresh",
            agentId: "agent",
            title: "fresh",
            revision: "c1",
            createdAt: Date.now(),
            taskState: { state: "idle" },
          },
          messages: structuredClone(messages),
          projectionRevision: "c1",
          lastEventSeq: events.length,
          retainedFloor: 1,
        };
        return checked("ConversationProjection", projection);
      },
      async send(cid, body) {
        assert.equal(cid, "fresh");
        assert.equal(body.content, ordinaryToolsPrompt);
        for (const opaque of [
          "native-a",
          "r0",
          "computer",
          "agent",
          "fresh",
          input.toString("utf8").trim(),
        ])
          assert.ok(!body.content.includes(opaque));
        if (!submitted) {
          submitted = true;
          messages.push({
            messageId: admission.messageId,
            role: "user",
            content: body.content,
            timestamp: Date.now(),
          });
          event("message.committed", messages[0]);
          if (mode !== "no-job") event("approval.requested", approval, "job");
        }
        return admission;
      },
    },
    approvals: {
      async get() {
        return approval;
      },
      async decide(id, decision) {
        assert.equal(id, approval.approvalId);
        assert.equal(decision.operationDigest, approval.operation.operationDigest);
        remote++;
        return {
          ...approval,
          version: 2,
          state: "approved",
          decidedBy: "scoped-client",
          decidedAt: Date.now(),
        };
      },
    },
    jobs: {
      async get() {
        return structuredClone(job);
      },
    },
    tasks: {
      async get() {
        return {
          taskId: "root-task",
          conversationId: "fresh",
          version: 2,
          status: { state: "completed" },
        };
      },
    },
    uploads: {
      async receipt() {
        return receipt;
      },
    },
    workspaces: {
      async get() {
        if (consent && mode === "foreign-workspace")
          return checked("WorkspaceBinding", { ...current, workspaceId: "foreign-workspace" });
        return consent && mode !== "uncommitted-write" ? current : workspace.binding;
      },
      async manifest() {
        return {
          workspaceId: "computer",
          revision: "r1",
          manifestHash: changedHash,
          manifest: {
            version: 1,
            entries: workspace.files.map((file) => ({
              type: "file" as const,
              mode: 420,
              ...file,
              ...(file.path === "notes.txt"
                ? { size: expected.length, sha256: sha256(expected) }
                : {}),
            })),
          },
        };
      },
      async read(_workspaceId, query) {
        if (query.path === "binary.bin") return binary;
        assert.equal(query.path, "notes.txt");
        return query.revision === "r0"
          ? input
          : mode === "missing-nonce"
            ? Buffer.from("ordinary-tools-verified\n")
            : expected;
      },
    },
  };
  return {
    client,
    workspace,
    configuration,
    target,
    events,
    agentId: "agent",
    conversationId: "fresh",
    request: async <T>(operation: () => Promise<T>) => operation(),
    until: async <T>(read: () => Promise<T>, accept: (value: T) => boolean) => {
      for (let i = 0; i < 3; i++) {
        const value = await read();
        if (accept(value)) return value;
      }
      throw new Error("Controlled public boundary absent");
    },
    async localConsent() {
      assert.equal(remote, 1);
      consent++;
      job = {
        ...waiting,
        state: "completed",
        version: 3,
        execution:
          mode === "wrong-target"
            ? { ...execution, target: { ...target, executorId: "unselected-b" } }
            : execution,
        preparedResult: {
          identity: execution,
          sequence: 1,
          state: "succeeded",
          commitId: receipt.commitId,
          manifestHash: receipt.manifestHash,
          output: { tail: expected.toString("utf8"), artifacts: [], truncated: false },
          possibleExternalEffects: true,
        },
        receipt,
        evidence: { kind: "committed", receipt },
      };
      checked("Job", job);
      event("job.state.changed", job, "job");
      event("task.completed", {
        taskId: "root-task",
        conversationId: "fresh",
        version: 2,
        status: { state: "completed" },
      });
      return execution.executionId;
    },
    consent: () => consent,
  };
}

test("ordinary tool public oracle observes delayed genuine context before consent and independently verifies committed nonce bytes", async () => {
  const controlled = protocol();
  const result = await runOrdinaryTools(controlled);
  assert.equal(controlled.consent(), 1);
  assert.equal(result.workspace.binding.revision, "r1");
  assert.equal(result.evidence.observation.jobId, "job");
  for (const mode of [
    "no-context",
    "assistant-context",
    "no-job",
    "wrong-target",
    "missing-nonce",
    "uncommitted-write",
    "foreign-workspace",
  ] as const) {
    const failed = protocol(mode);
    await assert.rejects(() => runOrdinaryTools(failed), { name: /Error/ }, mode);
    if (["no-context", "assistant-context", "no-job"].includes(mode))
      assert.equal(failed.consent(), 0);
  }
  const configured = protocol();
  configured.configuration.routing = { kind: "explicit", targetIds: ["my-device"] };
  await assert.rejects(() => runOrdinaryTools(configured), /compatible initial routing/);
  assert.equal(configured.consent(), 0);
});

test("actual execution cleanup refuses pending public revocation after closing the daemon and stream", async () => {
  const source = await readFile(new URL("./live-execution-controls.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async function close() {"),
    end = source.indexOf("\n  try {", start);
  assert.ok(start >= 0 && end > start);
  const close = new Function(
    "assert",
    "installed",
    "stop",
    "stream",
    "roles",
    "rm",
    `
    let closed=false;
    const heldDone=[],executor={credential:{credentialId:'executor'}},issued={credential:{credentialId:'client'}},directory='controlled';
    ${stripTypeScriptTypes(source.slice(start, end))}
    return close();
  `,
  );
  let stopped = 0,
    streamClosed = 0,
    removed = 0;
  await assert.rejects(
    () =>
      close(
        assert,
        { async verifyUnchanged() {} },
        async () => {
          stopped++;
        },
        {
          close() {
            streamClosed++;
          },
          done: Promise.resolve(),
        },
        {
          async revokeAndWait() {
            return { state: "pending", pendingRecipients: [{ kind: "agent", id: "agent" }] };
          },
        },
        async () => {
          removed++;
        },
      ),
    /complete public revocation/,
  );
  assert.deepEqual([stopped, streamClosed, removed], [1, 1, 1]);
});

test("actual final verifier claim guard requires ordinary tools for Free live and independent evidence", async () => {
  const source = await readFile(
    new URL("../../scripts/verify-release-gates.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
      '      if (kind === "integrated" || kind === "live" || kind === "independent")',
    ),
    end = source.indexOf('      if (kind === "native")', start);
  assert.ok(start >= 0 && end > start);
  // Execute the existing final verifier boundary with controlled claim rows.
  // No producer/artifact/deployment authentication is claimed by this substitution.
  const guard = new Function(
    "assert",
    "kind",
    "r",
    "integratedClaims",
    "applicableLiveClaims",
    source.slice(start, end),
  );
  const rows = liveClaims.map((id) => ({ id }));
  for (const kind of ["live", "independent"]) {
    const check = (claims: typeof rows, backend = "free") =>
      guard(
        assert,
        kind,
        { claims, deployments: [{ backend }] },
        integratedClaims,
        applicableLiveClaims,
      );
    check(rows);
    const missing = rows.filter((row) => row.id !== "ordinary-tools");
    assert.throws(() => check(missing), /Missing required claim: ordinary-tools/);
    check(missing, "cloud-js");
  }
});
