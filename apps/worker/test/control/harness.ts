import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { freeInfrastructurePolicy } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import type { TestRecipient } from "./fixtures/recipients.js";
import type { FixtureControl } from "./fixtures/worker.js";

export const bootstrap = "synthetic-bootstrap-for-local-tests-0000000000000000";
export const config: D.Configuration = {
  version: 1,
  workspace: { kind: "local", executorId: "executor", rootBindingId: "root" },
  execution: { kind: "native", executorId: "executor", trust: "host" },
  routing: { kind: "explicit", targetIds: ["executor"] },
  models: [
    { providerId: "openai", modelId: "gpt-5.4", auth: { kind: "oauth", providerId: "openai" } },
    {
      providerId: "anthropic",
      modelId: "claude-opus-4-7",
      auth: { kind: "oauth", providerId: "anthropic" },
    },
    {
      providerId: "openai-codex",
      modelId: "gpt-5.4",
      auth: { kind: "oauth", providerId: "openai-codex" },
    },
  ],
  infrastructure: freeInfrastructurePolicy,
};
export function request<K extends D.OperationId>(
  operationId: K,
  body: D.OperationRequest<K>["body"],
  path: D.OperationRequest<K>["path"] = {} as D.OperationRequest<K>["path"],
): D.OperationRequest<K> {
  return { operationId, path, body, query: {} } as D.OperationRequest<K>;
}
export function value<T>(result: D.Outcome<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.value;
}
export const uuid = (): string => randomUUID().replaceAll("-", "");
export const scope = (actions: string[] = ["*"]): D.ResourceScope => ({
  agentIds: ["agent"],
  conversationIds: ["conversation"],
  workspaceIds: ["workspace"],
  executorIds: ["executor"],
  backendIds: ["cloud"],
  tools: ["*"],
  actions,
});
export async function harness(
  options: { modelAuthKey?: string | null; allowedOrigins?: string[] } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-control-"));
  const configPath = join(directory, "wrangler.json");
  const alias = Object.fromEntries(
    [
      "fortipi-contract",
      "ajv/dist/2020.js",
      "@earendil-works/pi-ai/models",
      "@earendil-works/pi-ai/providers/openai",
      "@earendil-works/pi-ai/providers/anthropic",
      "@earendil-works/pi-ai/providers/openai-codex",
    ].map((name) => [name, fileURLToPath(import.meta.resolve(name))]),
  );
  await writeFile(
    configPath,
    JSON.stringify({
      name: "fortipi-control-test",
      main: process.env.FORTIPI_CONTROL_TEST_SOURCE
        ? join(
            process.env.FORTIPI_CONTROL_TEST_SOURCE,
            "apps/worker/test/control/fixtures/worker.ts",
          )
        : resolve("apps/worker/test/control/fixtures/worker.ts"),
      ...(process.env.FORTIPI_CONTROL_TEST_SOURCE ? { alias } : {}),
      compatibility_date: "2026-11-10",
      compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
      vars: {
        FORTIPI_ADMIN_TOKEN: bootstrap,
        ...(options.modelAuthKey === null
          ? {}
          : { FORTIPI_MODEL_AUTH_KEY: options.modelAuthKey ?? "a1".repeat(32) }),
        FORTIPI_CONFIG: config,
        ...(options.allowedOrigins ? { FORTIPI_ALLOWED_ORIGINS: options.allowedOrigins } : {}),
      },
      durable_objects: {
        bindings: [
          { name: "CONTROL_PLANE", class_name: "TestControlPlane" },
          { name: "AGENT_SESSIONS", class_name: "TestRecipient" },
          { name: "WORKSPACES", class_name: "TestRecipient" },
        ],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["TestControlPlane", "TestRecipient"] }],
    }),
  );
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.XDG_CONFIG_HOME = join(directory, "xdg-config");
  process.env.XDG_CACHE_HOME = join(directory, "xdg-cache");
  const { createTestHarness } = await import("wrangler");
  const server = createTestHarness({ root: directory, workers: [{ configPath }] });
  await server.listen();
  const worker = server.getWorker<{
    CONTROL_PLANE: DurableObjectNamespace<FixtureControl>;
    AGENT_SESSIONS: DurableObjectNamespace<TestRecipient>;
    WORKSPACES: DurableObjectNamespace<TestRecipient>;
  }>();
  const env = await worker.getEnv();
  const cp = env.CONTROL_PLANE.getByName("control");
  const deploymentId = await cp.deployment();
  const auth = async (token = bootstrap, origin?: string): Promise<D.AuthContext> =>
    value(
      await cp.authenticate({
        bearer: token,
        deploymentId,
        requestId: uuid(),
        deadline: Date.now() + 30000,
        ...(origin ? { origin } : {}),
      }),
    );
  const mint = async (
    body: D.CredentialMint,
  ): Promise<Extract<D.CredentialReceipt, { state: "issued" }>> => {
    const response = value(await cp.mintCredential(await auth(), request("mintCredential", body)));
    if (response.status !== 201) assert.fail("Issuance rejected");
    if (response.body.state !== "issued") assert.fail("Expected first issuance");
    return response.body;
  };
  return {
    server,
    worker,
    env,
    cp,
    deploymentId,
    auth,
    mint,
    directory,
    async close() {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
