import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type {
  Conversation,
  DurableEvent,
  ResourceScope,
} from "../../packages/fortipi-contract/dist/index.js";
import {
  canonicalJson,
  type DeploymentIdentity,
  sha256,
} from "../../scripts/verify-release-gates.ts";
import type { Installed } from "../distribution/install.ts";
import { publicAccess } from "./live-access.ts";
import { publicFlow } from "./public-flow.ts";
import type { RoleContext } from "./roles.ts";

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
