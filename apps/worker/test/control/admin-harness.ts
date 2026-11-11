import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { freeInfrastructurePolicy } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.ts";

export const requestId = () => randomUUID().replaceAll("-", "");
export function dataScope(agentId: string, actions: string[]): D.ResourceScope {
  return {
    agentIds: [agentId],
    conversationIds: ["conversation"],
    workspaceIds: [],
    executorIds: [],
    backendIds: [],
    tools: [],
    actions,
  };
}
export function value<T>(result: D.Outcome<T>): T {
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result.value;
}
export type WireInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
};
export function adminConfig(bootstrap: string) {
  return {
    name: "admin-coordinator-test",
    main: resolve(
      process.env.FORTIPI_CONTROL_TEST_SOURCE ?? ".",
      "apps/worker/test/control/fixtures/admin.ts",
    ),
    ...(process.env.FORTIPI_CONTROL_TEST_SOURCE
      ? {
          alias: Object.fromEntries(
            [
              "fortipi-contract",
              "ajv/dist/2020.js",
              "@earendil-works/pi-ai/models",
              "@earendil-works/pi-ai/providers/openai",
              "@earendil-works/pi-ai/providers/anthropic",
              "@earendil-works/pi-ai/providers/openai-codex",
            ].map((name) => [name, fileURLToPath(import.meta.resolve(name))]),
          ),
        }
      : {}),
    compatibility_date: "2026-11-10",
    compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
    vars: {
      FORTIPI_ADMIN_TOKEN: bootstrap,
      FORTIPI_CONFIG: { version: 1, infrastructure: freeInfrastructurePolicy },
    },
    durable_objects: {
      bindings: [
        { name: "CONTROL_PLANE", class_name: "AdminFixtureControl" },
        { name: "AGENT_SESSIONS", class_name: "AdminPeerFixture" },
        { name: "WORKSPACES", class_name: "AdminPeerFixture" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["AdminFixtureControl", "AdminPeerFixture"] }],
  };
}
export async function adminHarness() {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-admin-coordinator-")),
    configPath = join(directory, "wrangler.json"),
    bootstrap = randomBytes(32).toString("hex");
  await writeFile(configPath, JSON.stringify(adminConfig(bootstrap)), { mode: 0o600 });
  const { createTestHarness } = await import("wrangler"),
    server = createTestHarness({ root: directory, workers: [{ configPath }] });
  await server.listen();
  const worker = server.getWorker();
  async function raw(path: string, token = bootstrap, init: WireInit = {}) {
    const headers = {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "X-Fortipi-Context": "forged-public-context",
    };
    return worker.fetch(new URL(path, "http://fixture").toString(), { ...init, headers });
  }
  return {
    ...adminClient(raw, bootstrap),
    async close() {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export function adminClient<R extends { status: number; text(): Promise<string> }>(
  raw: (path: string, token?: string, init?: WireInit) => Promise<R>,
  bootstrap: string,
) {
  async function op<K extends D.ControlOperationId>(
    input: D.OperationRequest<K>,
    token = bootstrap,
  ): Promise<D.Outcome<D.OperationResponse<K>>> {
    return JSON.parse(
      await (
        await raw("/fixture/operation", token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        })
      ).text(),
    );
  }
  async function mint(
    resources: D.ResourceScope,
    role: "admin" | "client" = "admin",
    grants?: D.Grant[],
  ): Promise<Extract<D.CredentialReceipt, { state: "issued" }>> {
    const response: D.Outcome<D.OperationResponse<"mintCredential">> = JSON.parse(
      await (
        await raw("/fixture/mint", bootstrap, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: requestId(),
            role,
            grants: grants ?? [{ grantId: "logical-admin", version: 1, resources }],
          }),
        })
      ).text(),
    );
    const receipt = value(response);
    assert.equal(receipt.status, 201);
    assert.equal(receipt.body.state, "issued");
    if (receipt.body.state !== "issued") assert.fail("Synthetic issuance absent");
    return receipt.body;
  }
  async function source(bytes: Uint8Array): Promise<string> {
    const response = value(
      await op({
        operationId: "createAgent",
        path: {},
        query: {},
        body: {
          requestId: requestId(),
          name: "admin-data-source",
          model: {
            providerId: "openai",
            modelId: "gpt-5.4",
            auth: { kind: "secretRef", secretRef: "SYNTHETIC_UNUSED_MODEL_KEY" },
          },
        },
      }),
    );
    assert.equal(response.status, 201);
    const agentId = response.body.agentId;
    assert.equal(
      (await raw(`/fixture/source/${agentId}`, bootstrap, { method: "PUT", body: bytes })).status,
      204,
    );
    return agentId;
  }
  async function observe(operationId: string, token: string): Promise<D.AdminOperation> {
    for (let i = 0; i < 14; i++) {
      const response = value(
        await op(
          {
            operationId: "getAdminOperation",
            path: { id: operationId },
            query: {},
            body: undefined,
          },
          token,
        ),
      );
      assert.equal(response.status, 200);
      if (response.body.state !== "pending" && response.body.state !== "running")
        return response.body;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("Bounded actual admin continuation did not settle");
  }
  return { bootstrap, raw, op, mint, source, observe };
}
