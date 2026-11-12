import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { AdminClient } from "../dist/admin.js";
import type { PrepareReceipt } from "../dist/assets.js";
import { verifyAssets } from "../dist/assets.js";
import { deploymentReceipt } from "../dist/deployment.js";
import { CliError, errorDiagnostic } from "../dist/errors.js";
import { runCommand } from "../dist/index.js";
import { writeProtected } from "../dist/profiles.js";
import { wranglerBin } from "../dist/wrangler.js";
import { config, json, server, temp } from "./fixtures.ts";

test("validated infrastructure errors expose actionable measurements without remote strings or invented reset", async (t) => {
  const canary = "synthetic-remote-secret-canary";
  let daily = false;
  let invalid = false;
  const { api } = await server(t, (_req, res) =>
    json(
      res,
      {
        error: {
          code: "quota_exceeded",
          message: canary,
          requestId: "request-pressure",
          retryable: false,
          details: {
            retryAfterMs: 1000,
            setup: canary,
            supportedContinuations: [canary],
            pressure: {
              resource: invalid ? canary : daily ? "requests" : "storage",
              scope: { kind: "install", id: canary },
              source: "policy",
              measurement: daily ? "observed" : "unknown",
              limit: daily ? 100 : 1024,
              remaining: 0,
              reason: canary,
              action: daily ? "retry-later" : "reclaim-storage",
              ...(daily ? { resetAt: 1731456000000, retryAt: 1731456001000 } : {}),
            },
          },
        },
      },
      429,
    ),
  );
  const failure = async () => {
    try {
      await api.call("getUsage", { path: {}, query: {}, body: undefined });
    } catch (error) {
      assert.ok(error instanceof CliError);
      return error;
    }
    assert.fail("expected infrastructure pressure");
  };
  const storage = await failure();
  assert.deepEqual(storage.pressure, {
    resource: "storage",
    source: "policy",
    measurement: "unknown",
    limit: 1024,
    remaining: 0,
    action: "reclaim-storage",
  });
  assert.equal(storage.pressure?.resetAt, undefined);
  assert.equal(storage.pressure?.retryAt, undefined);
  assert.ok(Object.isFrozen(storage.pressure));
  assert.equal(errorDiagnostic(storage).includes(canary), false);
  assert.deepEqual(JSON.parse(errorDiagnostic(storage)), {
    error: { code: "http_429", pressure: storage.pressure },
  });
  daily = true;
  const requests = await failure();
  assert.deepEqual(requests.pressure, {
    resource: "requests",
    source: "policy",
    measurement: "observed",
    limit: 100,
    remaining: 0,
    action: "retry-later",
    resetAt: 1731456000000,
    retryAt: 1731456001000,
  });
  assert.equal(errorDiagnostic(requests).includes(canary), false);
  invalid = true;
  const rejected = await failure();
  assert.equal(rejected.code, "invalid_error_response");
  assert.equal(rejected.pressure, undefined);
  assert.equal(errorDiagnostic(rejected).includes(canary), false);
});

test("authenticated origin and identity remain bound when the caller changes its profile", async (t) => {
  let intendedRequests = 0;
  let otherRequests = 0;
  const intended = await server(t, (req, res) => {
    intendedRequests++;
    assert.equal(req.headers.authorization, "Bearer synthetic-bound-admin");
    json(res, { state: "healthy", pressure: [] });
  });
  const other = await server(t, (_req, res) => {
    otherRequests++;
    json(res, { state: "healthy", pressure: [] });
  });
  const profile = {
    version: 1 as const,
    endpoint: intended.endpoint,
    role: "admin" as const,
    token: "synthetic-bound-admin",
  };
  const api = new AdminClient(profile, { allowLoopback: true });
  profile.endpoint = other.endpoint;
  profile.token = "synthetic-replaced-admin";
  await api.call("getAdminHealth", { path: {}, query: {}, body: undefined });
  assert.equal(otherRequests, 0, "a changed profile must never redirect the bound identity");
  assert.equal(intendedRequests, 1);
});

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

test("artifact delivery rechecks protection after the remote wait and clears failed output", async (t) => {
  const root = await temp(t);
  const output = join(root, "changed.bin");
  const bytes = Buffer.from("synthetic private export canary");
  const { api } = await server(t, (_req, res) => {
    void chmod(output, 0o644).then(() => {
      res.writeHead(200, { "content-length": bytes.length });
      res.end(bytes);
    });
  });
  await assert.rejects(
    api.download(
      {
        artifactId: "artifact-A",
        endpoint: "/v1/admin/artifacts/artifact-A",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        scope: { kind: "workspace", workspaceId: "workspace-A", revision: "revision-A" },
      },
      output,
      1024,
    ),
    /artifact_download_incomplete/,
  );
  assert.equal((await lstat(output)).size, 0);
});

test("artifact identity, full-response bounds and cancellation fail without leaving partial exports", {
  timeout: 5000,
}, async (t) => {
  const root = await temp(t);
  const bytes = Buffer.from("synthetic bounded artifact");
  const artifact = {
    artifactId: "artifact-A",
    endpoint: "/v1/admin/artifacts/artifact-A",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    scope: { kind: "agent" as const, agentId: "agent-A", conversationIds: ["conversation-A"] },
  };
  let mode = "range";
  let requests = 0;
  let closed = Promise.withResolvers<void>();
  let partialObserved: Promise<boolean> | undefined;
  const controller = new AbortController();
  const { endpoint } = await server(t, (req, res) => {
    requests++;
    assert.equal(req.url, artifact.endpoint);
    assert.equal(req.headers.range, undefined, "full downloads must not request a partial body");
    res.once("close", () => closed.resolve());
    res.writeHead(mode === "range" ? 206 : 200, {
      "content-length": mode === "length" ? bytes.length + 1 : bytes.length,
      ...(mode === "range" ? { "content-range": `bytes 0-0/${bytes.length}` } : {}),
    });
    res.write(bytes.subarray(0, 1));
    if (mode === "abort")
      partialObserved = (async () => {
        let observed = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          if ((await lstat(join(root, "abort.bin"))).size === 1) {
            observed = true;
            break;
          }
          await delay(5);
        }
        controller.abort();
        return observed;
      })();
    // A rejected header or cancellation must close this unfinished server response promptly.
  });
  const api = new AdminClient(
    { version: 1, endpoint, role: "admin", token: "synthetic-admin" },
    { allowLoopback: true, signal: controller.signal, timeoutMs: 3000 },
  );
  await assert.rejects(
    api.download(
      { ...artifact, endpoint: "/v1/admin/artifacts/other" },
      join(root, "wrong.bin"),
      1024,
    ),
    /artifact_endpoint_mismatch/,
  );
  await assert.rejects(
    api.download(artifact, join(root, "bound.bin"), 1),
    /artifact_exceeds_bound/,
  );
  assert.equal(requests, 0);
  for (mode of ["range", "length", "abort"]) {
    closed = Promise.withResolvers<void>();
    const path = join(root, `${mode}.bin`);
    await assert.rejects(api.download(artifact, path, 1024), /artifact_download_incomplete/);
    await closed.promise;
    assert.equal((await lstat(path)).size, 0);
  }
  assert.equal(requests, 3);
  assert.equal(await partialObserved, true, "cancellation must clear bytes already written");
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
  // Bin resolution verifies the installed exact package version without executing
  // Wrangler against this user's legacy OS-home store. Real execution belongs to
  // the separately isolated installed offline-consumer harness.
  // An explicit child environment makes this a sentinel check, even on hosts without secrets.
  // Only synthetic identities are provided; no ambient credentials need to be inspected.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict';
       import { wranglerEnvironment } from ${JSON.stringify(new URL("../dist/wrangler.js", import.meta.url).href)};
       import { tuiEnvironment } from ${JSON.stringify(new URL("../dist/tui.js", import.meta.url).href)};
       const request = { args: [], cwd: ${JSON.stringify(root)} };
       const offline = wranglerEnvironment(request);
       const deployment = wranglerEnvironment({ ...request, deploymentAuth: true });
       const tui = tuiEnvironment();
       for (const env of [offline, deployment, tui]) {
         for (const key of ['FORTIPI_ADMIN_TOKEN', 'FORTIPI_MODEL_AUTH_KEY', 'OPENAI_API_KEY',
                            'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS'])
           assert.equal(env[key], undefined, key);
       }
       for (const env of [offline, tui]) {
         assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
         assert.equal(env.CLOUDFLARE_ACCOUNT_ID, undefined);
       }
       assert.equal(deployment.CLOUDFLARE_API_TOKEN, 'synthetic-cf-role');
       assert.equal(deployment.CLOUDFLARE_ACCOUNT_ID, 'synthetic-cf-account');
       console.log('role sentinels passed');`,
    ],
    {
      env: {
        PATH: "/synthetic-no-tools",
        FORTIPI_ADMIN_TOKEN: "synthetic-admin-role",
        FORTIPI_MODEL_AUTH_KEY: "synthetic-encryption-role",
        OPENAI_API_KEY: "synthetic-openai-role",
        ANTHROPIC_API_KEY: "synthetic-anthropic-role",
        NPM_TOKEN: "synthetic-npm-role",
        GITHUB_TOKEN: "synthetic-github-role",
        NODE_OPTIONS: "--no-warnings",
        CLOUDFLARE_API_TOKEN: "synthetic-cf-role",
        CLOUDFLARE_ACCOUNT_ID: "synthetic-cf-account",
      },
      timeout: 10000,
    },
  );
  assert.equal(stdout.trim(), "role sentinels passed");
});
