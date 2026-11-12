import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { PrepareReceipt } from "../../../packages/fortipi-cli/dist/assets.js";
import { deploymentReceipt } from "../../../packages/fortipi-cli/dist/deployment.js";
import { repository } from "../../build-workspaces.ts";
import {
  assertTarget,
  cloudflareRequest,
  observeDeployment,
  type TargetDescriptor,
} from "../../deploy-smoke.ts";
import { childEnvironment, execute } from "../../prepare-release.ts";
import { object, readJson, sha256 } from "../../verify-release-gates.ts";
import { candidate, discard, httpFixture, temporary } from "./fixtures.ts";

test("protected metadata reader admits only the exact recovery namespace inventory and retains its request bound", async () => {
  const account = "a".repeat(32);
  const path = "/workers/durable_objects/namespaces?page=1&per_page=1000";
  const seen: string[] = [];
  const rows = [{ id: "namespace-fixture", class: "AgentSession", use_sqlite: true }];
  const server = await httpFixture((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, "Bearer synthetic-cloud-read-only");
    seen.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ success: true, result: rows }));
  });
  try {
    const read = cloudflareRequest(
      account,
      sha256(account),
      "synthetic-cloud-read-only",
      server.transport,
    );
    assert.deepEqual(await read(path), rows);
    assert.deepEqual(seen, [`/client/v4/accounts/${account}${path}`]);
    for (const rejected of [
      "/workers/durable_objects/namespaces",
      path.replace("page=1", "page=2"),
      path.replace("1000", "1001"),
      `${path}&other=true`,
      "/workers/durable_objects/namespaces/fixture/objects",
      "/workers/scripts/../secrets",
    ])
      await assert.rejects(read(rejected));
    assert.equal(seen.length, 1, "Rejected routes must never reach credentialed transport");
    for (let count = 1; count < 32; count++) await read(path);
    await assert.rejects(read(path));
    assert.equal(seen.length, 32, "Recovery must not broaden the existing request budget");
  } finally {
    await server.close();
  }
});

test("actual CLI prepare plus HTTP version/rollout/configuration reads bind current Free identity and reject paid/split drift", {
  timeout: 120000,
}, async () => {
  const root = await temporary("fortipi-deployment-gate-");
  let fault = "";
  const cloudRole = "synthetic-cloud-metadata-role";
  const adminRole = "synthetic-application-admin-role";
  const observed: { path: string; role: string | undefined }[] = [];
  const operator = await readJson(
    resolve(repository, "packages/fortipi-cli/templates/operator-config.example.json"),
  );
  const target: TargetDescriptor = {
    schemaVersion: 1,
    accountBindingSha256: sha256("a".repeat(32)),
    backend: "free",
    operator,
  };
  assertTarget(target);
  const prepared = resolve(root, "prepared");
  const result = await execute(
    process.execPath,
    [
      resolve(repository, "packages/fortipi-cli/dist/bin.js"),
      "prepare",
      "--config",
      resolve(repository, "packages/fortipi-cli/templates/operator-config.example.json"),
      "--directory",
      prepared,
      "--non-interactive",
      "--json",
    ],
    root,
    childEnvironment(),
    120000,
  );
  assert.equal(result.code, 0);
  const receipt = JSON.parse(result.stdout) as PrepareReceipt;
  const wrangler = object(await readJson(resolve(prepared, "wrangler.json")));
  const runtime = object(object(operator).runtime);
  const c = candidate();
  c.sourceCommit = receipt.sourceCommit;
  c.assetManifestSha256 = receipt.assetManifestSha256;
  const version = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  // External deployment output is explicitly synthetic; the actual prepared bytes are not substituted.
  const cli = deploymentReceipt(
    JSON.stringify({
      type: "deploy",
      version: 1,
      worker_name: object(object(operator).deployment).name,
      version_id: version,
      targets: [object(object(operator).deployment).origin],
    }),
    receipt,
  );
  const server = await httpFixture((request, response) => {
    const path = request.url ?? "";
    observed.push({ path, role: request.headers.authorization });
    let value: unknown;
    if (path.startsWith("/client/v4/")) {
      assert.equal(request.headers.authorization, `Bearer ${cloudRole}`);
      if (path.endsWith("/workers/subdomain"))
        value = {
          subdomain:
            fault === "origin"
              ? "other-account"
              : new URL(String(object(object(operator).deployment).origin)).hostname.split(".")[1],
        };
      else if (path.endsWith("/subdomain")) value = { enabled: true, previews_enabled: false };
      else if (path.endsWith("/deployments"))
        value = {
          deployments: [
            {
              id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
              strategy: "percentage",
              versions: [{ version_id: version, percentage: fault === "split" ? 99 : 100 }],
            },
          ],
        };
      else if (path.endsWith(`/versions/${version}`)) {
        const migrations = wrangler.migrations;
        assert.ok(Array.isArray(migrations));
        const durable = object(wrangler.durable_objects).bindings;
        assert.ok(Array.isArray(durable));
        value = {
          id: version,
          resources: {
            script: {
              named_handlers: [
                "ControlPlane",
                "AgentSession",
                "WorkspaceObject",
                "WorkspaceProxy",
              ].map((name) => ({ name, handlers: ["fetch"] })),
            },
            script_runtime: {
              compatibility_date: wrangler.compatibility_date,
              compatibility_flags: wrangler.compatibility_flags,
              migration_tag: object(migrations.at(-1)).tag,
              exports: Object.fromEntries(
                ["ControlPlane", "AgentSession", "WorkspaceObject"].map((name) => [
                  name,
                  {
                    type: "durable-object",
                    storage: "sqlite",
                    ...(fault === "transfer" ? { state: "expecting-transfer" } : {}),
                  },
                ]),
              ),
            },
            bindings: [
              ...durable.map((v) => ({ type: "durable_object_namespace", ...object(v) })),
              { type: "ai", name: "AI" },
              { type: "json", name: "FORTIPI_CONFIG", json: runtime },
              ...(fault === "loader" ? [{ type: "worker_loader", name: "LOADER" }] : []),
            ],
          },
        };
      } else throw new Error("Unexpected metadata route");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ success: true, result: value }));
      return;
    }
    if (path === "/health") {
      assert.equal(request.headers.authorization, undefined);
      value = { status: "ok", protocolVersion: "1.0" };
    } else if (path === "/v1/admin/configuration") {
      assert.equal(request.headers.authorization, `Bearer ${adminRole}`);
      value = runtime;
    } else throw new Error("Unexpected application route");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  });
  try {
    const observe = () =>
      observeDeployment(
        c,
        sha256("candidate-fixture"),
        target,
        prepared,
        cli,
        cloudflareRequest("a".repeat(32), target.accountBindingSha256, cloudRole, server.transport),
        server.transport,
        adminRole,
      );
    const identity = await observe();
    assert.equal(identity.workerVersionId, version);
    assert.deepEqual(identity.versions, [{ versionId: version, percentage: 100 }]);
    assert.equal(identity.publicConfigurationVersion, 0);
    assert.equal(identity.capabilities.loaders, false);
    assert.equal(identity.capabilities.containers, false);
    assert.equal(identity.assetManifestSha256, receipt.assetManifestSha256);
    assert.equal(JSON.stringify(identity).includes("synthetic-"), false);
    assert.equal(JSON.stringify(identity).includes("a".repeat(32)), false);
    assert.equal(identity.accountBindingSha256, target.accountBindingSha256);
    const before = observed.length;
    assert.throws(
      () =>
        cloudflareRequest("a".repeat(32), sha256("different account"), cloudRole, server.transport),
      /hash binding mismatch/,
    );
    assert.equal(observed.length, before);
    const unsafe = structuredClone(target);
    object(object(unsafe.operator).deployment).accountId = "a".repeat(32);
    assert.throws(() => assertTarget(unsafe), /omit the secret/);
    fault = "split";
    await assert.rejects(observe(), /Split or stale/);
    fault = "loader";
    await assert.rejects(observe());
    fault = "transfer";
    await assert.rejects(observe());
    fault = "origin";
    const beforeOrigin = observed.filter(
      (value) => value.path === "/v1/admin/configuration",
    ).length;
    await assert.rejects(observe(), /not this account/);
    assert.equal(
      observed.filter((value) => value.path === "/v1/admin/configuration").length,
      beforeOrigin,
      "Account origin mismatch must precede app-role transport",
    );
    fault = "";
    assert.equal((await observe()).deploymentId, identity.deploymentId);
    assert.ok(observed.some((o) => o.path === "/v1/admin/configuration"));
    const saved = await readFile(resolve(prepared, "prepare-receipt.json"), "utf8");
    assert.equal(saved.includes(cloudRole), false);
    assert.equal(saved.includes("a".repeat(32)), false);
  } finally {
    await server.close();
    await discard(root);
  }
});
