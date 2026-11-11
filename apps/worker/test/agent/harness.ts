import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { freeInfrastructurePolicy } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import type { ControlPlane, TestAgentSession } from "./runtime-worker.js";
import type { StorageGuardProbe } from "./storage-guard-worker.js";

export const bootstrap = "synthetic-thread5-bootstrap-not-production-0000000000";
export const pause = (ms: number) => new Promise<void>((accept) => setTimeout(accept, ms));
export async function eventually<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await fn();
    if (predicate(value)) return value;
    await pause(20);
  }
  assert.fail("Expected runtime state did not commit");
}
export async function harness(
  options: { events?: number; traffic?: "free"; origin?: string; main?: string } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-agent-"));
  const configPath = join(directory, "wrangler.json");
  const policy = structuredClone(freeInfrastructurePolicy);
  // Synthetic traffic headroom isolates state oracles from CP RPC amplification.
  // This fixture makes no claim about the default Free request cadence.
  if (options.traffic !== "free") {
    policy.bounds.requestsPerPrincipalMinute = 10000;
    policy.bounds.requestsPerInstallMinute = 10000;
  }
  if (options.events) policy.bounds.conversationEvents = options.events;
  await writeFile(
    configPath,
    JSON.stringify({
      name: "fortipi-agent",
      main: options.main ?? resolve("apps/worker/test/agent/runtime-worker.ts"),
      compatibility_date: "2026-11-10",
      compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
      vars: {
        FORTIPI_ADMIN_TOKEN: bootstrap,
        FORTIPI_CONFIG: { version: 1, infrastructure: policy },
        ...(options.origin ? { FORTIPI_ALLOWED_ORIGINS: [options.origin] } : {}),
      },
      durable_objects: {
        bindings: [
          { name: "CONTROL_PLANE", class_name: "ControlPlane" },
          {
            name: "AGENT_SESSIONS",
            class_name: "TestAgentSession",
          },
          { name: "WORKSPACES", class_name: "WorkspaceObject" },
          { name: "GUARD_PROBE", class_name: "StorageGuardProbe" },
        ],
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: [
            "ControlPlane",
            "TestAgentSession",
            "WorkspaceObject",
            "StorageGuardProbe",
          ],
        },
      ],
    }),
  );
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.XDG_CONFIG_HOME = join(directory, "xdg");
  process.env.XDG_CACHE_HOME = join(directory, "cache");
  const { createTestHarness } = await import("wrangler");
  const server = createTestHarness({ root: directory, workers: [{ configPath }] });
  await server.listen();
  const env = await server
    .getWorker<{
      AGENT_SESSIONS: DurableObjectNamespace<TestAgentSession>;
      CONTROL_PLANE: DurableObjectNamespace<ControlPlane>;
      GUARD_PROBE: DurableObjectNamespace<StorageGuardProbe>;
    }>()
    .getEnv();
  const api = async <T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    token = bootstrap,
  ): Promise<{ status: number; body: T }> => {
    const response = await server.fetch(`http://fortipi.local${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as T };
  };
  return {
    server,
    env,
    api,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function setup(h: Awaited<ReturnType<typeof harness>>) {
  const agent = await h.api<D.Agent>("/v1/agents", {
    requestId: crypto.randomUUID(),
    name: "durable-test",
    model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
  });
  if (agent.status !== 201) {
    const cp = h.env.CONTROL_PLANE.getByName("control");
    const authenticated = await cp.authenticate({
      bearer: bootstrap,
      deploymentId: h.env.CONTROL_PLANE.idFromName("control").toString(),
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 30000,
    });
    console.log({ diagnosticAuthenticate: authenticated.ok });
    if (authenticated.ok) {
      const direct = await cp.createAgent(authenticated.value, {
        operationId: "createAgent",
        path: {},
        query: {},
        body: {
          requestId: crypto.randomUUID(),
          name: "direct",
          model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
        },
      });
      console.log({ diagnosticDirect: direct.ok ? direct.value.status : direct.code });
    }
    console.log(h.server.getLogs());
  }
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  const conversation = await h.api<D.Conversation>(
    `/v1/agents/${agent.body.agentId}/conversations`,
    { requestId: crypto.randomUUID(), title: "test" },
  );
  if (conversation.status !== 201)
    console.log(await h.env.AGENT_SESSIONS.getByName(agent.body.agentId).diagnose());
  assert.equal(conversation.status, 201, JSON.stringify(conversation.body));
  return { agent: agent.body, conversation: conversation.body };
}
