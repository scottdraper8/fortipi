import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AdminClient } from "../dist/admin.js";
import type { PrepareReceipt } from "../dist/assets.js";
import { verifyAssets } from "../dist/assets.js";
import { deploymentReceipt } from "../dist/deployment.js";
import { runCommand } from "../dist/index.js";
import { writeProtected } from "../dist/profiles.js";
import { tuiEnvironment } from "../dist/tui.js";
import { wrangler, wranglerBin, wranglerEnvironment } from "../dist/wrangler.js";
import { config, json, server, temp } from "./fixtures.ts";

test("public management uses canonical CAS DTOs and reports durable pending revocation truthfully", async (t) => {
  const root = await temp(t);
  const requests: { url: string; method: string }[] = [];
  const { endpoint } = await server(t, (req, res) => {
    requests.push({ url: req.url ?? "", method: req.method ?? "" });
    if (req.url === "/v1/admin/credentials/credential-A/revoke") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        assert.deepEqual(JSON.parse(body), { requestId: "request-A", expectedGeneration: 2 });
        json(
          res,
          {
            state: "pending",
            operationId: "operation-A",
            revocationId: "revocation-A",
            pendingRecipients: [{ kind: "agent", id: "agent-A" }],
          },
          202,
        );
      });
    } else if (req.url === "/v1/admin/operations/operation-A")
      json(res, {
        operationId: "operation-A",
        kind: "revocation",
        state: "pending",
        artifacts: [],
      });
    else json(res, { state: "healthy", pressure: [] });
  });
  await writeProtected(join(root, "default.json"), {
    version: 1,
    endpoint,
    role: "admin",
    token: "synthetic-admin",
  });
  const input = join(root, "revoke.json");
  await writeFile(input, JSON.stringify({ requestId: "request-A", expectedGeneration: 2 }));
  const context = {
    signal: new AbortController().signal,
    profileDirectory: root,
    allowLoopback: true,
  };
  const receipt = (await runCommand(
    ["credentials", "revoke", "--id", "credential-A", "--input", input, "--json"],
    context,
  )) as { state: string };
  assert.equal(receipt.state, "pending");
  const observation = (await runCommand(["export", "status", "--id", "operation-A"], context)) as {
    state: string;
  };
  assert.equal(observation.state, "pending");
  await runCommand(["status"], context);
  assert.equal(requests.length, 3);
  await writeFile(
    input,
    JSON.stringify({ requestId: "request-B", expectedGeneration: 2, token: "synthetic-canary" }),
  );
  await assert.rejects(
    runCommand(["credentials", "revoke", "--id", "credential-A", "--input", input], context),
    /invalid_contract_input/,
  );
  assert.equal(requests.length, 3);
});

test("schema-valid conflict and redirect/oversize failures remain bounded and never leak server messages", async (t) => {
  let mode = "conflict";
  let requests = 0;
  const { api, endpoint } = await server(t, (_req, res) => {
    requests++;
    if (mode === "redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:1/secret" });
      res.end();
    } else if (mode === "oversize") {
      res.end("x".repeat(1048577));
    } else
      json(
        res,
        {
          error: {
            code: "conflict",
            message: "synthetic-canary",
            requestId: "request-A",
            retryable: false,
            details: { reason: "version_mismatch" },
          },
        },
        409,
      );
  });
  await assert.rejects(
    api.call("patchConfiguration", {
      path: {},
      query: {},
      body: { requestId: "request-A", expectedVersion: 0, configuration: (await config()).runtime },
    }),
    (e) =>
      e instanceof Error && e.message === "version_conflict" && "exitCode" in e && e.exitCode === 4,
  );
  mode = "redirect";
  await assert.rejects(
    api.call("getConfiguration", { path: {}, query: {}, body: undefined }),
    /transport_failed/,
  );
  mode = "oversize";
  await assert.rejects(
    api.call("getConfiguration", { path: {}, query: {}, body: undefined }),
    /invalid_response/,
  );
  assert.equal(requests, 3);
  assert.throws(
    () => new AdminClient({ version: 1, endpoint, token: "synthetic", role: "admin" }),
    /invalid_origin/,
  );
});

test("real artifact streaming checks descriptor hash/length and clears interrupted protected output", async (t) => {
  const root = await temp(t);
  const bytes = Buffer.from("synthetic nonsecret export");
  let broken = false;
  const { api } = await server(t, (_req, res) => {
    res.writeHead(200, { "content-length": bytes.length });
    res.end(broken ? Buffer.alloc(bytes.length, 120) : bytes);
  });
  const artifact = {
    artifactId: "artifact-A",
    endpoint: "/v1/admin/artifacts/artifact-A",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    scope: { kind: "agent" as const, agentId: "agent-A", conversationIds: ["conversation-A"] },
  };
  const good = join(root, "good.bin");
  assert.equal((await api.download(artifact, good, 1024)).bytes, bytes.length);
  assert.deepEqual(await readFile(good), bytes);
  assert.equal((await lstat(good)).mode & 0o777, 0o600);
  broken = true;
  const bad = join(root, "bad.bin");
  await assert.rejects(api.download(artifact, bad, 1024), /artifact_download_incomplete/);
  assert.equal((await lstat(bad)).size, 0);
});

test("missing asset input is explicit and deployment receipts reject ambiguous or changed targets", async (t) => {
  const root = await temp(t);
  await assert.rejects(
    verifyAssets(join(root, "missing-assets")),
    /actual_service5_worker_assets_required/,
  );
  const c = await config();
  const prepared: PrepareReceipt = {
    schemaVersion: 1,
    operator: c,
    packageVersion: "0.1.0",
    sourceCommit: "a".repeat(40),
    assetManifestSha256: "b".repeat(64),
    configSha256: "c".repeat(64),
  };
  const record = {
    type: "deploy",
    version: 1,
    worker_name: c.deployment.name,
    version_id: "12345678-1234-4234-8234-123456789abc",
    targets: [c.deployment.origin],
  };
  assert.ok(deploymentReceipt(`${JSON.stringify(record)}\n`, prepared));
  assert.throws(
    () => deploymentReceipt(`${JSON.stringify(record)}\n${JSON.stringify(record)}\n`, prepared),
    /ambiguous_deployment_record/,
  );
  assert.throws(
    () =>
      deploymentReceipt(
        JSON.stringify({ ...record, targets: ["https://other.example"] }),
        prepared,
      ),
    /deployment_target_mismatch/,
  );
});

test("actual pinned Wrangler is externally resolved; child role environments exclude application/provider identities", async (t) => {
  const root = await temp(t);
  assert.match(await wranglerBin(), /wrangler[/\\]bin[/\\]wrangler\.js$/);
  const output = await wrangler.run({ args: ["--version"], cwd: root });
  assert.match(output, /4\.160\.0/);
  for (const env of [
    wranglerEnvironment({ args: [], cwd: root }),
    wranglerEnvironment({ args: [], cwd: root, deploymentAuth: true }),
    tuiEnvironment(),
  ])
    for (const name of Object.keys(env))
      assert.equal(
        /FORTIPI_ADMIN_TOKEN|FORTIPI_MODEL_AUTH_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|NPM_TOKEN|GITHUB_TOKEN/.test(
          name,
        ),
        false,
      );
});
