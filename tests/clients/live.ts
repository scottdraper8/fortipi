import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Conversation,
  DurableEvent,
  ResourceScope,
} from "../../packages/fortipi-contract/dist/index.js";
import {
  canonicalJson,
  type DeploymentIdentity,
  object,
  regularBytes,
  sha256,
  string,
} from "../../scripts/verify-release-gates.ts";
import type { Installed } from "../distribution/install.ts";
import { publicAccess } from "./live-access.ts";
import { runLiveAllocationRefusals } from "./live-allocation-refusals.ts";
import { publicRequestPressure } from "./live-pressure.ts";
import { runLiveTaskControls } from "./live-task-controls.ts";
import { runLiveWorkspace } from "./live-workspace.ts";
import {
  type ApplicationRecoveryBridge,
  type ExistingApplicationRecoveryBridge,
  openRecoveryCanary,
  type RecoveryWorkspaceCanary,
  runApplicationRecovery,
  runExistingApplicationRecovery,
} from "./platform-recovery.ts";
import { publicFlow } from "./public-flow.ts";
import type { RoleContext } from "./roles.ts";

/** Trusted inherited-IPC bridge only, separate from candidate read authority.
 * This is never accepted from EvidenceInput, a descriptor or an env flag. */
export type LiveRecoveryBridge =
  | { mode: "perform"; bridge: ApplicationRecoveryBridge }
  | { mode: "verify-existing"; bridge: ExistingApplicationRecoveryBridge };

async function until(read: () => Promise<boolean>, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await read()) return;
    await new Promise<void>((accept) => setTimeout(accept, 100));
  }
  throw new Error("Actual live committed model task did not complete before its deadline");
}
/** Called only by the trusted live coordinator, against the unchanged candidate.
 * Credentials stay in this context; clients receive one scoped application role. */
export async function liveContext(
  installed: Installed,
  deployment: DeploymentIdentity,
  roles: RoleContext,
) {
  assert.equal(deployment.origin, roles.endpoint);
  assert.equal(new URL(roles.endpoint).protocol, "https:");
  const configuration = await roles.call({
    operationId: "getConfiguration",
    path: {},
    query: {},
    body: undefined,
  });
  assert.equal(configuration.version, deployment.publicConfigurationVersion);
  assert.equal(sha256(canonicalJson(configuration)), deployment.runtimeConfigSha256);
  let models = await roles.call({
    operationId: "listModels",
    path: {},
    query: { limit: 100 },
    body: undefined,
  });
  const select = () =>
    configuration.models.find(
      (model) =>
        model.providerId === "cloudflare" &&
        models.items.some(
          (available) =>
            available.available &&
            available.providerId === model.providerId &&
            available.modelId === model.modelId,
        ),
    );
  let selected = select();
  const pages = new Set<string>();
  while (!selected && models.nextPageToken) {
    assert.ok(!pages.has(models.nextPageToken), "Model discovery pagination repeated a cursor");
    pages.add(models.nextPageToken);
    models = await roles.call({
      operationId: "listModels",
      path: {},
      query: { limit: 100, pageToken: models.nextPageToken },
      body: undefined,
    });
    selected = select();
  }
  assert.ok(selected, "A configured and available actual Workers AI model is required");
  const agent = await roles.call({
    operationId: "createAgent",
    path: {},
    query: {},
    body: { requestId: randomUUID(), name: "evidence-1010-live", model: selected },
  });
  const conversations: Conversation[] = [];
  for (let i = 0; i < 3; i++)
    conversations.push(
      await roles.call({
        operationId: "createConversation",
        path: { agentId: agent.agentId },
        query: {},
        body: { requestId: randomUUID(), title: `evidence-1010-live-${i}` },
      }),
    );
  const clientResources: ResourceScope = {
    agentIds: [agent.agentId],
    conversationIds: conversations.map((conversation) => conversation.conversationId),
    workspaceIds: [],
    executorIds: [],
    backendIds: [],
    tools: [],
    actions: [
      "agents.list",
      "agents.read",
      "conversations.list",
      "conversations.create",
      "conversations.read",
      "conversations.fork",
      "messages.submit",
      "events.read",
      "tasks.read",
      "tasks.cancel",
      "tickets.mint",
    ],
  };
  const role = await roles.issue({
    requestId: randomUUID(),
    role: "client",
    expiresAt: Date.now() + 900000,
    grants: [{ grantId: randomUUID(), version: 1, resources: clientResources }],
  });
  const module = (await import(
    pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/node`)).href
  )) as typeof import("../../packages/fortipi-client/dist/node.js");
  const client = () =>
    new module.FortiPiClient({ endpoint: roles.endpoint, credentials: async () => role.token });
  let workspaceCanary: RecoveryWorkspaceCanary | undefined;
  return {
    role,
    agent,
    conversations,
    client,
    access: () =>
      publicAccess(installed, roles, {
        agentId: agent.agentId,
        conversationId: conversations[0]!.conversationId,
        excludedConversationId: conversations[1]!.conversationId,
      }),
    async authorizeCreated(title: string) {
      let id: string | undefined;
      await until(async () => {
        const page = await roles.call({
          operationId: "listConversations",
          path: { agentId: agent.agentId },
          query: { limit: 100 },
          body: undefined,
        });
        const created = page.items.filter((conversation) => conversation.title === title);
        assert.ok(created.length <= 1);
        id = created[0]?.conversationId;
        return !!id;
      });
      assert.ok(id);
      const issued = await roles.issue({
        requestId: randomUUID(),
        role: "client",
        expiresAt: Date.now() + 900000,
        grants: [
          {
            grantId: randomUUID(),
            version: 1,
            resources: {
              ...clientResources,
              conversationIds: [conversations[2]!.conversationId, id],
            },
          },
        ],
      });
      return {
        endpoint: roles.endpoint,
        token: issued.token,
        agentId: agent.agentId,
        conversationId: id,
      };
    },
    async infrastructure() {
      const observed = await client().negotiate();
      // The public logical application identity is its ControlPlane object ID.
      // DeploymentIdentity.deploymentId is the provider rollout ID. Bind the
      // public identity through an actual scoped ticket, never equate the two.
      const ticket = await client().tickets.mint(agent.agentId, conversations[0]!.conversationId);
      assert.equal(observed.deploymentId, ticket.identity.deploymentId);
      assert.equal(ticket.identity.credential.credentialId, role.credential.credentialId);
      assert.deepEqual(observed.infrastructure, configuration.infrastructure);
      assert.ok(
        observed.infrastructure.accountPlan === "unknown" ||
          observed.infrastructure.accountPlan === deployment.capabilities.plan,
        "A known policy plan must agree with the authenticated actual deployment; conservative unknown is not an entitlement claim",
      );
      if (deployment.backend === "free") {
        assert.equal(deployment.capabilities.loaders, false);
        assert.equal(deployment.capabilities.containers, false);
        for (const kind of ["cloud-js", "linux"] as const) {
          const backend = observed.backends.find((backend) => backend.kind === kind);
          assert.ok(
            backend && !backend.available && backend.reason,
            "Unavailable paid binding must be explicit before any tool invocation",
          );
        }
      }
      return {
        providerDeploymentId: deployment.deploymentId,
        logicalApplicationId: observed.deploymentId,
        authenticatedRuntimeConfigSha256: deployment.runtimeConfigSha256,
        exactConfigurationVersion: configuration.version,
        protocolAndConfigurationPolicyAgree: true,
        declaredPlan: observed.infrastructure.accountPlan,
        authenticatedDeploymentPlan: deployment.capabilities.plan,
        backends: observed.backends,
        noUnavailableBackendInvocation: deployment.backend === "free",
        limitation:
          "Discovery/configuration prerequisite only; bounded ordinary live activity and account-wide/platform refusal proofs are separate",
      };
    },
    async requestPressure() {
      const evidence = await publicRequestPressure({ installed, roles, agentId: agent.agentId });
      const current = await roles.call({
        operationId: "getConfiguration",
        path: {},
        query: {},
        body: undefined,
      });
      assert.equal(sha256(canonicalJson(current)), deployment.runtimeConfigSha256);
      return {
        ...evidence,
        observation: {
          ...evidence.observation,
          providerDeploymentId: deployment.deploymentId,
          authenticatedRuntimeConfigSha256: deployment.runtimeConfigSha256,
        },
      };
    },
    publicRole: async (index: number, usage: "python" | "tui" | "browser") => {
      const conversation = conversations[index];
      assert.ok(conversation);
      const actions = [
        "conversations.read",
        "messages.submit",
        "events.read",
        "tasks.read",
        "tickets.mint",
      ];
      if (usage !== "browser")
        actions.push("agents.list", "agents.read", "conversations.list", "conversations.create");
      if (usage === "tui") actions.push("tasks.cancel");
      const issued = await roles.issue({
        requestId: randomUUID(),
        role: "client",
        expiresAt: Date.now() + 900000,
        grants: [
          {
            grantId: randomUUID(),
            version: 1,
            resources: {
              ...clientResources,
              conversationIds: [conversation.conversationId],
              actions,
            },
          },
        ],
      });
      return {
        endpoint: roles.endpoint,
        token: issued.token,
        credential: issued.credential,
        agentId: agent.agentId,
        conversationId: conversation.conversationId,
      };
    },
    clientForRole: (token: string) =>
      new module.FortiPiClient({ endpoint: roles.endpoint, credentials: async () => token }),
    async workspace() {
      const connection = client();
      const protocol = await connection.negotiate();
      assert.deepEqual(protocol.infrastructure, configuration.infrastructure);
      const ticket = await connection.tickets.mint(agent.agentId, conversations[0]!.conversationId);
      assert.equal(ticket.identity.deploymentId, protocol.deploymentId);
      assert.equal(ticket.identity.credential.credentialId, role.credential.credentialId);
      // The qualified helper consumes a three-field PUBLIC observation view,
      // as in its independent local qualification. Never replace the real
      // provider DeploymentIdentity with this logical application identity.
      const evidence = await runLiveWorkspace({
        installed,
        roles,
        deployment: {
          origin: roles.endpoint,
          deploymentId: protocol.deploymentId,
          publicConfigurationVersion: configuration.version,
        },
      });
      const workspaceId = evidence.observation.workspaceId;
      const files = evidence.observation.files;
      assert.equal(typeof workspaceId, "string");
      assert.ok(typeof workspaceId === "string" && Array.isArray(files) && files.length === 3);
      const binding = await roles.call({
        operationId: "describeWorkspace",
        path: { workspaceId },
        query: {},
        body: undefined,
      });
      assert.equal(binding.config.kind, "computer");
      assert.equal(binding.revision, evidence.observation.publishedRevision);
      workspaceCanary = {
        binding,
        files: files.map((file: unknown) => {
          assert.ok(file && typeof file === "object");
          const item = file as { path?: unknown; size?: unknown; sha256?: unknown };
          assert.ok(typeof item.path === "string" && typeof item.sha256 === "string");
          assert.match(item.sha256, /^[0-9a-f]{64}$/);
          assert.ok(
            typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0,
          );
          return { path: item.path, size: item.size, sha256: item.sha256 };
        }),
      };
      return {
        ...evidence,
        observation: {
          ...evidence.observation,
          providerDeploymentId: deployment.deploymentId,
          logicalApplicationId: protocol.deploymentId,
          authenticatedRuntimeConfigSha256: deployment.runtimeConfigSha256,
          helperIdentityView: "public-protocol",
        },
      };
    },
    async allocationRefusals() {
      assert.ok(workspaceCanary, "Actual independently verified Computer canary is required");
      return runLiveAllocationRefusals({ installed, roles, workspace: workspaceCanary });
    },
    async pendingTaskControls() {
      assert.ok(workspaceCanary, "Actual independently verified Computer canary is required");
      const evidence = await runLiveTaskControls({
        installed,
        roles,
        agentId: agent.agentId,
        workspace: workspaceCanary,
        deployment,
      });
      return {
        ...evidence,
        observation: {
          ...evidence.observation,
          providerDeploymentId: deployment.deploymentId,
          authenticatedRuntimeConfigSha256: deployment.runtimeConfigSha256,
        },
      };
    },
    async applicationRecovery(input: LiveRecoveryBridge, out: string) {
      await mkdir(out, { recursive: true, mode: 0o700 });
      const directory = await lstat(out);
      assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
      assert.equal(directory.mode & 0o777, 0o700);
      assert.equal(await realpath(out), out);
      if (input.mode === "perform") {
        assert.ok(workspaceCanary, "Actual independently verified Computer canary is required");
        const pending = await openRecoveryCanary({
          installed,
          roles,
          agentId: agent.agentId,
          workspace: workspaceCanary,
        });
        const canary = await pending.seed();
        return {
          mode: input.mode,
          ...(await runApplicationRecovery({
            deployment,
            canary,
            client: pending.client,
            out,
            bridge: input.bridge,
          })),
        };
      }
      // Obtain original resource IDs only from the actual lineage bridge and
      // hash-bound checkpoint under the agreed private directory. A new live
      // agent's role cannot read the original canary; never widen it to '*'.
      // The inherited protocol permits verifyExisting exactly once. Preserve
      // that actual reply in memory for both scoping and the unchanged domain
      // wrapper; a second transport call would fail its phase sequence.
      const lineage = structuredClone(await input.bridge.verifyExisting());
      assert.equal(lineage.status, "lineage-confirmed");
      if (lineage.status !== "lineage-confirmed")
        throw new Error("Original recovery lineage unavailable");
      assert.deepEqual(lineage.current, deployment);
      assert.equal(lineage.evidence.candidateSha256, installed.hash);
      const file = lineage.before;
      assert.equal(file.path, resolve(out, "application-before.json"));
      assert.ok(file.mode === 0o600 && file.size > 0 && file.size <= 1048576);
      const bytes = await regularBytes(file.path);
      assert.equal(bytes.byteLength, file.size);
      assert.equal((await lstat(file.path)).mode & 0o777, file.mode);
      assert.equal(sha256(bytes), file.sha256);
      const before = object(JSON.parse(bytes.toString()));
      assert.equal(bytes.toString(), `${canonicalJson(before)}\n`);
      assert.equal(before.schemaVersion, 1);
      assert.equal(before.candidateSha256, installed.hash);
      assert.equal(before.sourceCommit, installed.candidate.sourceCommit);
      assert.equal(before.workerVersionId, lineage.operation.before.workerVersionId);
      assert.equal(before.deploymentId, lineage.operation.before.deploymentId);
      const id = (value: unknown) => {
        const result = string(value, 128);
        assert.notEqual(result, "*");
        return result;
      };
      const originalAgent = id(before.agentId),
        originalConversation = id(before.conversationId);
      const workspace = object(object(before.workspace).binding),
        workspaceId = id(workspace.workspaceId),
        target = object(before.target);
      assert.equal(object(workspace.config).kind, "computer");
      const operation = object(object(before.approval).operation);
      assert.deepEqual(operation.target, target);
      assert.equal(operation.tool, "shell");
      assert.ok(target.kind === "executor" || target.kind === "backend");
      const actual = await roles.call({
        operationId: "getConversation",
        path: { id: originalConversation },
        query: {},
        body: undefined,
      });
      assert.equal(actual.conversation.agentId, originalAgent);
      assert.deepEqual(
        await roles.call({
          operationId: "describeWorkspace",
          path: { workspaceId },
          query: {},
          body: undefined,
        }),
        workspace,
      );
      const readRole = await roles.issue({
        requestId: randomUUID(),
        role: "client",
        expiresAt: Date.now() + 900000,
        grants: [
          {
            grantId: randomUUID(),
            version: 1,
            resources: {
              agentIds: [originalAgent],
              conversationIds: [originalConversation],
              workspaceIds: [workspaceId],
              executorIds: target.kind === "executor" ? [id(target.executorId)] : [],
              backendIds: target.kind === "backend" ? [id(target.backendId)] : [],
              tools: ["shell"],
              actions: [
                "conversations.read",
                "events.read",
                "tasks.read",
                "jobs.read",
                "approvals.read",
                "workspaces.read",
                "workspace.read",
              ],
            },
          },
        ],
      });
      const reader = new module.FortiPiClient({
        endpoint: roles.endpoint,
        credentials: async () => readRole.token,
      });
      let consumed = false;
      const retainedReply: ExistingApplicationRecoveryBridge = {
        async verifyExisting() {
          assert.equal(consumed, false);
          consumed = true;
          return lineage;
        },
      };
      return {
        mode: input.mode,
        // All domain/byte/identity assertions still run on the actual reply;
        // this in-process handoff grants no archive/provider authority.
        ...(await runExistingApplicationRecovery({
          deployment,
          client: reader,
          bridge: retainedReply,
        })),
      };
    },
    async authorizeConversation(id: string) {
      const created = await roles.call({
        operationId: "getConversation",
        path: { id },
        query: {},
        body: undefined,
      });
      assert.equal(created.conversation.agentId, agent.agentId);
      const issued = await roles.issue({
        requestId: randomUUID(),
        role: "client",
        expiresAt: Date.now() + 900000,
        grants: [
          {
            grantId: randomUUID(),
            version: 1,
            resources: { ...clientResources, conversationIds: [id] },
          },
        ],
      });
      return {
        endpoint: roles.endpoint,
        token: issued.token,
        agentId: agent.agentId,
        conversationId: id,
      };
    },
    async workersAi() {
      const connection = client(),
        conversation = conversations[0]!;
      const seen: DurableEvent[] = [];
      const subscription = connection.conversations.subscribe(conversation.conversationId, {
        agentId: agent.agentId,
        maxReconnects: 0,
        onSnapshot() {},
        onEvent(event) {
          if (event.durability === "durable") seen.push(event);
        },
      });
      try {
        await subscription.ready;
        const intent = connection.messageIntent(
          conversation.conversationId,
          "Reply with one short greeting. Do not invoke tools.",
          "followUp",
        );
        const receipt = await intent.send();
        await until(async () =>
          seen.some((event) => event.type === "task.completed" && event.taskId === receipt.taskId),
        );
        const task = await connection.tasks.get(receipt.taskId);
        assert.equal(task.status.state, "completed");
        const answer = seen.find(
          (event) => event.type === "message.completed" && event.taskId === receipt.taskId,
        );
        assert.ok(
          answer,
          "Live model completion requires a task-correlated canonical assistant fact",
        );
        const snapshot = await connection.conversations.get(conversation.conversationId);
        const messageId = (answer.payload as { messageId?: string }).messageId;
        assert.ok(
          snapshot.messages.some(
            (message) =>
              message.messageId === messageId &&
              message.role === "assistant" &&
              message.content.trim().length > 0,
          ),
        );
        assert.deepEqual(await intent.send(), receipt);
        const observation = {
          actualWorkersAi: true,
          configuredProvider: selected.providerId,
          configuredModel: selected.modelId,
          taskId: task.taskId,
          committedAssistantMessageId: messageId,
          canonicalEventId: answer.eventId,
          publicConfigurationVersion: configuration.version,
          originalReceiptRetained: true,
          unmodifiedCandidate: true,
        };
        roles.assertSanitized(observation);
        return observation;
      } finally {
        subscription.close();
        await subscription.done.catch(() => {});
      }
    },
    async publicNode() {
      return publicFlow(client(), client(), {
        agentId: agent.agentId,
        conversationId: conversations[1]!.conversationId,
        seed: 1010,
      });
    },
  };
}
