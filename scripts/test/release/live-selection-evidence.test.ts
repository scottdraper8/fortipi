// Actual filesystem journals, AES custody and SDK public operations. Only
// credential/server/Actions/provider records are controlled, never LIVE proof.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { protocol } from "../../../packages/fortipi-client/test/fixtures/wire.ts";
import type {
  CredentialMint,
  WorkspaceOperationLease,
} from "../../../packages/fortipi-contract/dist/index.js";
import { RoleContext } from "../../../tests/clients/roles.ts";
import type { Installed } from "../../../tests/distribution/install.ts";
import type { TargetDescriptor } from "../../deploy-smoke.ts";
import {
  assertSelectionOwnership,
  cleanupSelectionResources,
  createSelectionOwnership,
  SelectionJournal,
  type SelectionOwnership,
  type SelectionStage,
  selectionTarget,
  sendSelectionTurn,
  settleOwnedStage,
} from "../../live-selection-evidence.ts";
import {
  canonicalJson,
  type DeploymentIdentity,
  readJson,
  saveJson,
  sha256,
} from "../../verify-release-gates.ts";
import { candidate } from "./fixtures.ts";

const admin = "synthetic-selection-admin-value-1010";
async function privateControlDirectory(prefix: string) {
  const root = resolve(import.meta.dirname, "../../../.agent-docs/tmp");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(resolve(root, prefix));
}
async function ownership(): Promise<SelectionOwnership> {
  const c = candidate(),
    operator = JSON.parse(
      await readFile(
        new URL(
          "../../../packages/fortipi-cli/templates/operator-config.example.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  operator.runtime.routing = { kind: "prefer-local", targetIds: [] };
  const target: TargetDescriptor = {
    schemaVersion: 1,
    backend: "free",
    accountBindingSha256: sha256("account"),
    operator,
  };
  return createSelectionOwnership(
    {
      loaded: { candidate: c, hash: sha256(`${canonicalJson(c)}\n`) },
      target,
      job: {
        producer: {
          workflowPath: ".github/workflows/deploy.yml",
          workflowSha256: sha256("workflow"),
          workflowId: 1,
          runId: 2,
          runAttempt: 1,
        },
        job: {
          id: 3,
          name: "initial-installed-deployment",
          runnerId: 4,
          runnerName: "controlled",
          labels: ["ubuntu-24.04"],
          startedAt: new Date().toISOString(),
          completedAt: null,
        },
        checkedAt: new Date().toISOString(),
      },
    },
    ["selection-a", "selection-b"],
  );
}
function phase(owned: SelectionOwnership, name: "a" | "b" | "f"): DeploymentIdentity {
  return {
    schemaVersion: 1,
    sourceCommit: owned.sourceCommit,
    candidateSha256: owned.candidateSha256,
    accountBindingSha256: owned.body.reviewedTarget.accountBindingSha256,
    slot: "production",
    workerName: "fortipi",
    origin: "https://fortipi.example.workers.dev",
    workerVersionId: `${name.repeat(8)}-${name.repeat(4)}-4${name.repeat(3)}-8${name.repeat(3)}-${name.repeat(12)}`,
    deploymentId: `${name.repeat(8)}-${name.repeat(4)}-4${name.repeat(3)}-9${name.repeat(3)}-${name.repeat(12)}`,
    versions: [
      {
        versionId: `${name.repeat(8)}-${name.repeat(4)}-4${name.repeat(3)}-8${name.repeat(3)}-${name.repeat(12)}`,
        percentage: 100,
      },
    ],
    configSha256: sha256(name),
    runtimeConfigSha256: sha256(name),
    assetManifestSha256: sha256("assets"),
    publicConfigurationVersion: 1,
    capabilities: { plan: "free", loaders: false, containers: false },
    backend: "free",
    imageDigest: null,
    checkedAt: new Date().toISOString(),
  };
}
function declaredA(owned: SelectionOwnership) {
  const deployment = phase(owned, "a");
  owned.body.phases.push({
    phase: "a",
    target: selectionTarget(owned.body.reviewedTarget, owned.body.executorIds),
    intentAt: new Date().toISOString(),
    deployment,
  });
  owned.body.issuanceDeployment = deployment;
  owned.body.workspaceId = "workspace";
}
const writerScope = {
  agentIds: [],
  conversationIds: [],
  workspaceIds: ["workspace"],
  executorIds: [],
  backendIds: [],
  tools: [],
  actions: ["workspace.read", "workspace.write", "workspaces.read"],
};
test("acknowledged admission before any approval/job remains independently cancellable; lost send stays unknown without retry", async (t) => {
  const directory = await privateControlDirectory("selection-admission-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "ownership.json"),
    owned = await ownership();
  declaredA(owned);
  owned.body.agentId = "agent";
  owned.body.conversations["preferred-a"] = "conversation-a";
  owned.body.conversations["preferred-b"] = "conversation-b";
  const roles = new RoleContext("https://fortipi.example.workers.dev", admin),
    calls: string[] = [];
  let cancelled = false,
    ambiguous = false,
    expectedCancel = "";
  roles.call = (async (input: {
    operationId: string;
    body: CredentialMint & { requestId: string };
    path: { id?: string };
  }) => {
    calls.push(input.operationId);
    if (input.operationId === "mintCredential")
      return {
        state: "issued",
        role: "client",
        expiresAt: input.body.expiresAt,
        token: `synthetic-token-${input.body.requestId}`,
        credential: { credentialId: input.body.requestId, generation: 1, grantVersion: 1 },
      };
    if (input.operationId === "describeTask") {
      assert.equal(input.path.id, "accepted-task");
      return {
        taskId: "accepted-task",
        conversationId: "conversation-a",
        version: cancelled ? 2 : 1,
        status: { state: cancelled ? "cancelled" : "queued" },
      };
    }
    if (input.operationId === "cancelTask") {
      assert.equal(input.path.id, "accepted-task");
      assert.equal(input.body.requestId, expectedCancel);
      cancelled = true;
      return {
        operationId: "cancel",
        durableIntent: true,
        disposition: {
          state: ambiguous ? "unknown" : "not-started",
          possibleExternalEffects: ambiguous,
        },
      };
    }
    assert.equal(input.operationId, "revokeCredential");
    return {
      operationId: `revoke-${input.path.id}`,
      revocationId: `revocation-${input.path.id}`,
      state: "complete",
      pendingRecipients: [],
    };
  }) as RoleContext["call"];
  const journal = new SelectionJournal(owned, roles, admin, async (saved) => {
    await saveJson(path, saved, false);
  });
  await journal.save();
  const scope = (conversationId: string) => ({
    ...writerScope,
    agentIds: ["agent"],
    conversationIds: [conversationId],
  });
  const role = await journal.mint("preferred-a-client", {
    ...writerMint(owned),
    grants: [{ grantId: "client-a", version: 1, resources: scope("conversation-a") }],
  });
  let sends = 0;
  const client = {
    conversations: {
      send: async (_id: string, input: { clientRequestId: string }) => {
        sends++;
        const disk = await readJson(path);
        assertSelectionOwnership(disk);
        assert.equal(disk.body.admissions[0]?.state, "unknown");
        assert.equal(disk.body.admissions[0]?.input.clientRequestId, input.clientRequestId);
        assert.ok(disk.body.admissions[0]?.cancelRequestId);
        return {
          operationId: "admission",
          messageId: "accepted-message",
          taskId: "accepted-task",
          revision: "revision",
          eventSeq: 1,
        };
      },
    },
  };
  const sent = await sendSelectionTurn(
    journal,
    client,
    "preferred-a",
    "dispatch",
    "Use the configured workspace.",
    role.credential,
  );
  expectedCancel = sent.row.cancelRequestId;
  // Simulate loss immediately after this ack; no approval event/proof is needed.
  const disk = await readJson(path);
  assertSelectionOwnership(disk);
  assert.equal(disk.body.jobs.length, 0);
  assert.equal(disk.body.admissions[0]?.receipt?.taskId, "accepted-task");
  const cleanup = await cleanupSelectionResources({
    ownership: disk,
    roles,
    settleStage: async () => {},
  });
  assert.equal(cleanup.admissions[0]?.state, "complete");
  assert.equal(cleanup.admissions[0]?.task?.status.state, "cancelled");
  assert.equal(cancelled, true);
  assert.equal(sends, 1);
  assert.ok(!calls.includes("describeJob"));
  assert.equal(cleanup.state, "blocked", "No F qualification is inferred from resource cleanup");
  cancelled = false;
  ambiguous = true;
  const uncertainControl = await cleanupSelectionResources({
    ownership: disk,
    roles,
    settleStage: async () => {},
  });
  assert.equal(uncertainControl.admissions[0]?.state, "unknown");
  assert.ok(
    uncertainControl.roles.filter((row) => row.credential).every((row) => row.state === "complete"),
  );
  ambiguous = false;
  const other = await journal.mint("preferred-b-client", {
    ...writerMint(owned),
    grants: [{ grantId: "client-b", version: 1, resources: scope("conversation-b") }],
  });
  const lost = {
    conversations: {
      send: async () => {
        sends++;
        throw new Error("Controlled lost send acknowledgement");
      },
    },
  };
  await assert.rejects(
    sendSelectionTurn(
      journal,
      lost,
      "preferred-b",
      "dispatch",
      "Use the configured workspace.",
      other.credential,
    ),
  );
  await assert.rejects(
    sendSelectionTurn(
      journal,
      lost,
      "preferred-b",
      "dispatch",
      "Use the configured workspace.",
      other.credential,
    ),
  );
  const unknown = await readJson(path);
  assertSelectionOwnership(unknown);
  assert.equal(unknown.body.admissions[1]?.state, "unknown");
  assert.equal(unknown.body.admissions[1]?.receipt, undefined);
  assert.equal(sends, 2);
  const final = await cleanupSelectionResources({
    ownership: unknown,
    roles,
    settleStage: async () => {},
  });
  assert.equal(final.admissions[1]?.state, "unknown");
  assert.equal(final.state, "blocked");
  assert.ok(final.roles.filter((r) => r.credential).every((r) => r.state === "complete"));
});
function writerMint(
  owned: SelectionOwnership,
): Omit<Extract<CredentialMint, { role: "client" | "admin" }>, "requestId"> {
  return {
    role: "client",
    expiresAt: owned.body.createdAt + 55 * 60000,
    grants: [{ grantId: "writer-grant", version: 1, resources: writerScope }],
  };
}

test("pre-F durable issuance ownership survives acknowledgement interruption; unknown response blocks without retry and still cleans known rows", async (t) => {
  const directory = await privateControlDirectory("selection-ownership-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "ownership.json"),
    owned = await ownership();
  declaredA(owned);
  const calls: string[] = [],
    roles = new RoleContext("https://fortipi.example.workers.dev", admin);
  const call: RoleContext["call"] = (async (input: {
    operationId: string;
    body: CredentialMint;
    path: { id?: string };
  }) => {
    calls.push(input.operationId);
    if (input.operationId === "mintCredential") {
      const disk = await readJson(path);
      assertSelectionOwnership(disk);
      assert.equal(disk.body.roles[0]!.issuance, "unknown", "persist BEFORE issuance");
      return {
        state: "issued",
        role: "client",
        expiresAt: input.body.expiresAt,
        credential: { credentialId: "known-writer", generation: 1, grantVersion: 1 },
        token: "synthetic-issued-writer-value",
      };
    }
    assert.equal(input.operationId, "revokeCredential");
    assert.equal(input.path.id, "known-writer");
    return {
      operationId: "revoke-operation",
      revocationId: "revocation",
      state: "complete",
      pendingRecipients: [],
    };
  }) as RoleContext["call"];
  roles.call = call;
  const journal = new SelectionJournal(owned, roles, admin, async (saved, cipher) => {
    await saveJson(path, saved, false);
    assert.ok(!JSON.stringify(saved).includes("synthetic-issued-writer-value"));
    if (saved.body.roles[0]!.issuance === "known" && !Object.keys(cipher).length)
      throw new Error("Controlled interruption after saved reference, before custody/F");
  });
  await journal.save();
  await assert.rejects(journal.mint("writer", writerMint(owned)));
  const recovered = await readJson(path);
  assertSelectionOwnership(recovered);
  assert.equal(recovered.body.roles[0]!.credential?.credentialId, "known-writer");
  const unknown = recovered.body.roles.find((r) => r.name === "peer-a")!;
  unknown.issuance = "unknown";
  unknown.mint = {
    requestId: unknown.mintRequestId,
    role: "executor",
    executorId: recovered.body.executorIds[0],
    expiresAt: recovered.body.createdAt + 55 * 60000,
    grants: [
      {
        grantId: "unknown-peer-grant",
        version: 1,
        resources: { ...writerScope, executorIds: [recovered.body.executorIds[0]] },
      },
    ],
  };
  unknown.mintSha256 = sha256(canonicalJson(unknown.mint));
  await saveJson(path, recovered, false);
  const cleanup = await cleanupSelectionResources({
    ownership: recovered,
    roles,
    settleStage: async () => {
      throw new Error("No stage expected");
    },
  });
  assert.equal(cleanup.roles[0]!.state, "complete");
  assert.equal(cleanup.roles.find((r) => r.name === "peer-a")!.state, "unknown");
  assert.equal(cleanup.state, "blocked");
  assert.equal(cleanup.finalDeployment, undefined);
  assert.equal(calls.filter((c) => c === "mintCredential").length, 1);
  assert.ok(calls.includes("revokeCredential"));

  // Lost response and loss BEFORE the reference save retain only unknown on disk.
  const uncertain = await ownership();
  declaredA(uncertain);
  const lostRoles = new RoleContext(roles.endpoint, admin);
  let mintAttempts = 0;
  lostRoles.call = (async () => {
    mintAttempts++;
    throw new Error("Controlled lost reply");
  }) as RoleContext["call"];
  const lost = new SelectionJournal(uncertain, lostRoles, admin, async (saved) => {
    await saveJson(path, saved, false);
  });
  await lost.save();
  await assert.rejects(lost.mint("writer", writerMint(uncertain)));
  await assert.rejects(lost.mint("writer", writerMint(uncertain)));
  const disk = await readJson(path);
  assertSelectionOwnership(disk);
  assert.equal(disk.body.roles[0]!.issuance, "unknown");
  assert.equal(disk.body.roles[0]!.credential, undefined);
  assert.equal(mintAttempts, 1);
  assert.equal(
    (await cleanupSelectionResources({ ownership: disk, roles, settleStage: async () => {} }))
      .state,
    "blocked",
  );
});

test("owned upload cleanup recovers the original sealed writer and identical registration; foreign custody refuses before public mutation", async (t) => {
  const owned = await ownership();
  declaredA(owned);
  const roles = new RoleContext("https://fortipi.example.workers.dev", admin),
    token = "synthetic-owner-writer-value";
  roles.call = (async () => ({
    state: "issued",
    role: "client",
    expiresAt: writerMint(owned).expiresAt,
    token,
    credential: { credentialId: "writer", generation: 1, grantVersion: 1 },
  })) as RoleContext["call"];
  const journal = new SelectionJournal(owned, roles, admin, async () => {});
  await journal.save();
  await journal.mint("writer", writerMint(owned));
  const lease: WorkspaceOperationLease = {
    ownerKind: "workspace-operation",
    leaseId: "lease",
    operationId: "operation",
    credential: { credentialId: "writer", generation: 1, grantVersion: 1 },
    registrationId: "original-registration",
    leaseVersion: 1,
    workspaceId: "workspace",
    executorId: "computer",
    executorGeneration: 1,
    fence: "1",
    baseRevision: "r0",
    expiresAt: Date.now() + 30000,
  };
  const stage: SelectionStage = {
    owner: "writer",
    workspaceId: "workspace",
    acquire: {
      requestId: "acquire",
      operationId: "operation",
      bindingVersion: 1,
      baseRevision: "r0",
      deadline: Date.now() + 120000,
    },
    releaseRequestId: "release",
    lease,
    begin: {
      requestId: "begin",
      operationId: "operation",
      commitId: "commit",
      lease,
      baseRevision: "r0",
      manifestHash: sha256("manifest"),
      manifest: { version: 1, entries: [] },
      mutations: [],
    },
    uploadId: "upload",
  };
  const installed = {
    candidate: { scope: "controlled" },
    resolveExport: () =>
      resolve(import.meta.dirname, "../../../packages/fortipi-client/dist/node.js"),
  } as unknown as Installed;
  let aborted = false,
    mutations = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/protocol") return Response.json(protocol);
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`);
    if (path === "/v1/workspaces/workspace/uploads/upload") {
      if (options?.method === "DELETE") {
        aborted = true;
        mutations++;
        return new Response(null, { status: 204 });
      }
      return Response.json({
        uploadId: "upload",
        state: aborted ? "aborted" : "open",
        baseRevision: "r0",
        manifestHash: sha256("manifest"),
        receivedChunks: [],
        expiresAt: Date.now() + 30000,
      });
    }
    assert.equal(path, "/v1/workspaces/workspace/leases/lease/release");
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body, { requestId: "release", lease, reason: "cancelled" });
    mutations++;
    return Response.json({ leaseId: "lease", released: true });
  };
  await settleOwnedStage(journal, installed, stage);
  assert.equal(stage.terminal, "aborted");
  assert.equal(stage.released, true);
  assert.equal(mutations, 2);
  const before = mutations;
  const foreign = structuredClone(journal.custody.writer!);
  foreign.frame.credentialRef.credentialId = "foreign";
  journal.custody.writer = foreign;
  await assert.rejects(
    settleOwnedStage(journal, installed, {
      ...stage,
      terminal: undefined,
      released: undefined,
    } as unknown as SelectionStage),
  );
  assert.equal(mutations, before);
});
