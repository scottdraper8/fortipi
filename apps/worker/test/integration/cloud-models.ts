import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freeInfrastructurePolicy } from "fortipi-contract";
import {
  offlineWranglerEnvironment,
  verifyOfflineWranglerAuth,
} from "../../../../tests/clients/offline-wrangler.ts";
import type * as D from "../../src/boundary/dto.js";
import { bootstrap, config } from "../control/harness.ts";

type Audit = { cipherHash: string; noPlaintext: boolean; ciphertextPresent: boolean };
type Peer = { refresh: number; openai: number; anthropic: number; rejected: number };
type Factory = {
  text: string[];
  stopped: boolean;
  failures: string[];
  startupCalls: number;
  resolutions: number;
  foreignReads: number;
  providerCount: number;
  completeFields: boolean;
  status: D.ProviderAuthStatus;
};
const pause = (ms: number) => new Promise<void>((accept) => setTimeout(accept, ms));
const sentinelPattern = /fortipi-model-canary-/;
async function port() {
  const socket = createServer();
  await new Promise<void>((accept) => socket.listen(0, "127.0.0.1", accept));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((accept, reject) =>
    socket.close((error) => (error ? reject(error) : accept())),
  );
  return address.port;
}
async function runtime() {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-model-security-")),
    selectedPort = await port();
  const configPath = join(directory, "wrangler.json"),
    origin = `http://127.0.0.1:${selectedPort}`;
  const executable = resolve(
    dirname(fileURLToPath(import.meta.resolve("wrangler"))),
    "../bin/wrangler.js",
  );
  await verifyOfflineWranglerAuth(executable);
  let child: ChildProcess | undefined;
  async function start(key: string | null = "a1".repeat(32)) {
    assert.equal(child, undefined);
    await writeFile(
      configPath,
      JSON.stringify({
        name: "fortipi-model-security",
        main: resolve("apps/worker/test/integration/model-auth-worker.ts"),
        compatibility_date: "2026-11-10",
        compatibility_flags: [
          "nodejs_compat",
          "enable_request_signal",
          "request_signal_passthrough",
        ],
        vars: {
          FORTIPI_ADMIN_TOKEN: bootstrap,
          FORTIPI_CONFIG: { ...config, infrastructure: freeInfrastructurePolicy },
          ...(key === null ? {} : { FORTIPI_MODEL_AUTH_KEY: key }),
          OPENAI_API_KEY: "fortipi-model-canary-openai-key",
          ANTHROPIC_API_KEY: "fortipi-model-canary-anthropic-key",
        },
        durable_objects: {
          bindings: [
            { name: "CONTROL_PLANE", class_name: "TestControlPlane" },
            { name: "MODEL_PEER", class_name: "ModelProtocolPeer" },
            { name: "AGENT_SESSIONS", class_name: "ModelAgent" },
            { name: "WORKSPACES", class_name: "WorkspaceObject" },
          ],
        },
        migrations: [
          {
            tag: "v1",
            new_sqlite_classes: [
              "TestControlPlane",
              "ModelProtocolPeer",
              "ModelAgent",
              "WorkspaceObject",
            ],
          },
        ],
      }),
    );
    child = spawn(
      process.execPath,
      [
        executable,
        "dev",
        "--local",
        "--config",
        configPath,
        "--persist-to",
        join(directory, "state"),
        "--port",
        String(selectedPort),
        "--ip",
        "127.0.0.1",
        "--inspector-port",
        "0",
      ],
      {
        cwd: directory,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: offlineWranglerEnvironment(directory),
      },
    );
    let output = "";
    child.stdout?.on("data", (bytes) => {
      output = (output + String(bytes)).slice(-16000);
    });
    child.stderr?.on("data", (bytes) => {
      output = (output + String(bytes)).slice(-16000);
    });
    for (let n = 0; n < 300; n++) {
      if (child.exitCode !== null) {
        await writeFile(join(directory, "startup.log"), output);
        assert.fail(
          "Synthetic model runtime exited; bounded startup.log retained in fixture directory",
        );
      }
      try {
        if ((await fetch(`${origin}/__models/ping`, { signal: AbortSignal.timeout(250) })).ok)
          return;
      } catch {}
      await pause(50);
    }
    await writeFile(join(directory, "startup.log"), output);
    assert.fail("Synthetic model runtime startup deadline exceeded");
  }
  async function stop(abrupt = false) {
    if (!child) return;
    const active = child;
    assert.ok(active.pid);
    if (active.exitCode !== null) {
      child = undefined;
      return;
    }
    if (abrupt && process.platform !== "win32") {
      const table = await promisify(execFile)("ps", ["-eo", "pid=,ppid=,pgid=,comm="]);
      assert.ok(
        table.stdout.split("\n").some((line) => {
          const fields = line.trim().split(/\s+/);
          return Number(fields[2]) === active.pid && fields.slice(3).join(" ").includes("workerd");
        }),
        "Actual workerd must be killed with wrapper",
      );
    }
    const exited = new Promise<void>((accept) => active.once("exit", () => accept()));
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(active.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      await new Promise<void>((accept) => killer.once("exit", () => accept()));
    } else process.kill(-active.pid, abrupt ? "SIGKILL" : "SIGTERM");
    await exited;
    if (abrupt && process.platform !== "win32") assert.equal(active.signalCode, "SIGKILL");
    child = undefined;
  }
  let publicResponses = 0;
  async function get<T>(
    path: string,
    body?: unknown,
    expectedStatus = 200,
    token = bootstrap,
  ): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    assert.equal(
      sentinelPattern.test(text),
      false,
      "Fixture/public responses must not contain plaintext credentials",
    );
    assert.equal(
      response.status,
      expectedStatus,
      `Scenario HTTP failure ${response.status} at ${path}`,
    );
    publicResponses++;
    return JSON.parse(text) as T;
  }
  return {
    start,
    stop,
    get,
    origin,
    responses: () => publicResponses,
    close: async () => {
      await stop();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    },
  };
}

export async function runModelsSecurity(): Promise<{
  observation: Record<string, unknown>;
  oracle: string;
  sensitivity: string[];
  limitations: string[];
}> {
  const h = await runtime();
  const probe = <T>(action: string, provider = "openai") =>
    h.get<T>(`/__models/probe?action=${action}&provider=${provider}`);
  const facts = () => h.get<Peer>("/__models/peer");
  const observations: Record<string, unknown> = {};
  const factory = async (provider: "openai" | "anthropic", mode: "oauth" | "secret") => {
    const result = await probe<Factory>(`factory-${mode}`, provider);
    assert.deepEqual(result.failures, [], `${provider} real adapter diagnostic`);
    assert.deepEqual(result.text, Array(2).fill(`${provider}-model-security-answer`));
    assert.equal(result.stopped, true);
    assert.equal(result.completeFields, true);
    assert.equal(result.startupCalls, 0);
    assert.equal(result.resolutions, mode === "oauth" ? 2 : 0);
    assert.equal(result.foreignReads, 0);
    assert.equal(result.providerCount, 1);
    return result;
  };
  try {
    await h.start();
    const refresh: Record<string, unknown> = {};
    for (const provider of ["openai", "anthropic"] as const) {
      await probe("seed", provider);
      const before = await facts(),
        result = await factory(provider, "oauth"),
        after = await facts();
      assert.equal(
        after.refresh - before.refresh,
        1,
        "Two expired-credential completions serialize one rotating refresh",
      );
      assert.equal(
        after[provider] - before[provider],
        2,
        "Both real provider requests must execute",
      );
      assert.equal(result.status.version, 2);
      assert.equal(result.status.generation, 1);
      refresh[provider] = {
        requests: 2,
        refreshes: 1,
        completeFields: true,
        version: 2,
        generation: 1,
        cpResolutions: result.resolutions,
        startupCalls: result.startupCalls,
      };
    }
    observations.concurrent = refresh;
    const beforeCrash = await probe<Audit>("audit");
    assert.equal(beforeCrash.ciphertextPresent, true);
    assert.equal(beforeCrash.noPlaintext, true);
    await h.get("/__models/canary?write=model-security-committed");
    await h.stop(true);
    await h.start();
    assert.equal(await h.get("/__models/canary"), "model-security-committed");
    assert.deepEqual(
      await probe<Audit>("audit"),
      beforeCrash,
      "Actual ciphertext bytes must survive real runtime death, without export/import",
    );
    for (const provider of ["openai", "anthropic"] as const) await factory(provider, "oauth");
    assert.equal(
      (await facts()).refresh,
      0,
      "Reopened complete credentials decrypt; no second exchange",
    );
    observations.reopen = {
      canary: true,
      identicalCiphertext: true,
      completeFields: true,
      refreshes: 0,
    };
    for (const provider of ["openai", "anthropic"] as const) await factory(provider, "secret");
    observations.narrowSecretBindings = true;
    const negative = await probe<{
      keyDenied: boolean[];
      invalidDenied: boolean;
      unsupportedDenied: boolean;
      selectionDenied: boolean[];
      missingSecretDenied: boolean;
      noLeak: boolean;
      ciphertextPreserved: boolean;
      crypto: Record<string, boolean>;
    }>("negatives");
    assert.deepEqual(negative.keyDenied, [true, true, true]);
    assert.deepEqual(negative.selectionDenied, [true, true]);
    for (const field of [
      "invalidDenied",
      "unsupportedDenied",
      "missingSecretDenied",
      "noLeak",
      "ciphertextPreserved",
    ] as const)
      assert.equal(negative[field], true, field);
    for (const checked of Object.values(negative.crypto))
      assert.equal(checked, true, "Actual AES/AAD/ciphertext rejection");
    observations.negative = negative;
    for (const action of ["stale-login", "replace", "logout"] as const) {
      const result = await probe<{
        blocked: boolean;
        managementOk: boolean;
        managementCode: string | null;
        generationAdvanced: boolean;
        versionAdvanced: boolean;
        staleGenerationDenied: boolean;
        retained: boolean;
        noLeak: boolean;
        resolverReturned: boolean;
        audit: Audit;
      }>(action, action === "logout" ? "anthropic" : "openai");
      assert.equal(result.blocked, true);
      assert.equal(result.managementOk, action !== "stale-login");
      if (action === "stale-login") assert.equal(result.managementCode, "conflict");
      assert.equal(
        result.resolverReturned,
        action === "stale-login",
        "A completed replacement/logout must fence the held resolver result",
      );
      for (const field of [
        "generationAdvanced",
        "versionAdvanced",
        "staleGenerationDenied",
        "retained",
        "noLeak",
      ] as const)
        assert.equal(result[field], true, `${action}: ${field}`);
      assert.equal(result.audit.noPlaintext, true);
      observations[action] = result;
    }
    const redirect = await probe<{
      rejected: boolean;
      state: string;
      noBlindRetry: boolean;
      noLeak: boolean;
    }>("redirect", "anthropic");
    assert.deepEqual(redirect, {
      rejected: true,
      noLeak: true,
      state: "reauth_required",
      noBlindRetry: true,
    });
    observations.redirect = redirect;
    const saved = await probe<Audit>("audit");
    for (const key of ["", "b2".repeat(32)]) {
      await h.stop();
      await h.start(key || null);
      const denied = await probe<{ ok: boolean; code: string; noLeak: boolean }>("resolve-check");
      assert.equal(denied.ok, false);
      assert.equal(denied.noLeak, true);
      // Models wraps a wrong-key store rejection; the CP outcome is internal.
      // The contract oracle is rejection/no network/no plaintext/no ciphertext change.
      assert.equal(denied.code, key ? "internal" : "unsupported");
      assert.deepEqual(await probe<Audit>("audit"), saved);
      assert.equal((await facts()).refresh, 0, "Binding rejection must precede provider exchange");
    }
    await h.stop();
    await h.start();
    assert.equal((await probe<{ ok: boolean }>("resolve-check")).ok, true);
    observations.bindingReopen = {
      missingDenied: true,
      wrongDenied: true,
      restored: true,
      ciphertextUnchanged: true,
    };
    observations.peer = await facts();
    observations.responsesCheckedForCanaries = h.responses();
    observations.publicPi = await publicAnswer();
    return {
      observation: observations,
      oracle:
        "Two expired requests refresh once, persist complete AES-GCM credentials before use, survive actual SIGKILL/reopen, serialize management behind held refresh, and deny stale generations/foreign endpoints/invalid bindings without plaintext publication.",
      sensitivity: [
        "Wrong key, wrong AAD and tampered authenticated ciphertext rejected with original ciphertext restored",
        "Missing/malformed key and invalid provider/credential/secret/endpoint selections rejected",
        "Held rotating refresh with stale login, valid replacement and logout; old-generation resolution rejected",
        "Real manual-redirect token response rejects without repeating uncertain refresh",
      ],
      limitations: [
        "Local real workerd/SQLite and actual Pi Models/factory adapters; protocol peers use supported fetch injection, not live provider subscriptions",
        "Persistent Wrangler process proves local crash recovery, not Cloudflare eviction",
        "No populated tool job/executor traffic is produced; real public Pi task/snapshot/status and denied/unknown-job responses are checked",
        "No Workers AI/Loader/Containers/Paid account, deployed provider OAuth, installed CLI login or release acceptance claim",
      ],
    };
  } finally {
    await h.close();
  }
}

async function publicAnswer() {
  // A separate installation isolates the public journey from the auth-race
  // fixture's request window, retaining the same unmodified Free policy.
  const h = await runtime();
  try {
    await h.start();
    await h.get("/__models/probe?action=seed&provider=openai");
    const agent = await h.get<D.Agent>(
      "/v1/agents",
      {
        requestId: crypto.randomUUID(),
        name: "model-security",
        model: {
          providerId: "openai",
          modelId: "gpt-5.4",
          auth: { kind: "oauth", providerId: "openai" },
        },
      },
      201,
    );
    const conversation = await h.get<D.Conversation>(
      `/v1/agents/${agent.agentId}/conversations`,
      { requestId: crypto.randomUUID() },
      201,
    );
    const client = await h.get<D.CredentialReceipt>(
      "/v1/admin/credentials",
      {
        requestId: crypto.randomUUID(),
        role: "client",
        grants: [
          {
            grantId: crypto.randomUUID(),
            version: 1,
            resources: {
              agentIds: [agent.agentId],
              conversationIds: [conversation.conversationId],
              workspaceIds: [],
              executorIds: [],
              backendIds: [],
              tools: [],
              actions: ["messages.submit", "conversations.read", "tasks.read", "jobs.read"],
            },
          },
        ],
      },
      201,
    );
    assert.equal(client.state, "issued");
    if (client.state !== "issued") assert.fail("Synthetic client issuance failed");
    const admitted = await h.get<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      {
        clientRequestId: crypto.randomUUID(),
        content: "model-security-public-input",
        busyBehavior: "followUp",
      },
      202,
      client.token,
    );
    let projection: D.ConversationProjection | undefined;
    for (let n = 0; n < 12; n++) {
      await pause(1000);
      projection = await h.get<D.ConversationProjection>(
        `/v1/conversations/${conversation.conversationId}`,
        undefined,
        200,
        client.token,
      );
      if (projection.conversation.taskState.state === "completed") break;
    }
    assert.ok(projection);
    assert.equal(projection.conversation.taskState.state, "completed");
    assert.equal(projection.messages.filter((message) => message.role === "user").length, 1);
    assert.deepEqual(
      projection.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
      ["openai-model-security-answer"],
    );
    const task = await h.get<D.Task>(`/v1/tasks/${admitted.taskId}`, undefined, 200, client.token);
    assert.equal(task.status.state, "completed");
    const status = await h.get<D.ProviderAuthStatus>("/v1/admin/models/openai/auth");
    assert.equal(status.state, "configured");
    await h.get("/v1/admin/models/openai/auth", undefined, 403, client.token);
    await h.get("/v1/jobs/nonexistent-model-security-job", undefined, 404, client.token);
    return {
      committedAnswer: true,
      userInputs: 1,
      terminalTask: true,
      statusRedacted: true,
      clientOwnGrant: true,
      adminStatusDeniedToClient: true,
      unknownJobRedacted: true,
      populatedToolJob: false,
      responsesCheckedForCanaries: h.responses(),
    };
  } finally {
    await h.close();
  }
}
