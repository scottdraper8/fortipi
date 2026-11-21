import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Protocol, ResourceScope } from "fortipi-contract";
import { spawn as ptySpawn } from "node-pty";
import { argv } from "../dist/argv.js";
import { readConfig } from "../dist/config.js";
import { type CommandContext, runCommand } from "../dist/index.js";
import type { AuthInteraction } from "../dist/model-auth.js";
import { readProtected } from "../dist/profiles.js";
import type { SetupResult } from "../dist/setup.js";
import { config, temp } from "./fixtures.ts";

const execute = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const emptyScope = (): ResourceScope => ({
  agentIds: [],
  workspaceIds: [],
  conversationIds: [],
  actions: [],
  tools: [],
  executorIds: [],
  backendIds: [],
});

async function harness(
  t: Parameters<typeof temp>[0],
  fault?: "deploy" | "credential",
  oauth = false,
) {
  const root = await temp(t);
  const operator = await config();
  operator.runtime.workspace = {
    kind: "local",
    executorId: "workspace-device",
    rootBindingId: "workspace-root",
  };
  operator.runtime.models.push(
    oauth
      ? {
          providerId: "anthropic",
          modelId: "claude-sonnet-4-5",
          auth: { kind: "oauth", providerId: "anthropic" },
        }
      : {
          providerId: "openai",
          modelId: "gpt-5",
          auth: { kind: "secretRef", secretRef: "EXISTING_PROVIDER_KEY" },
        },
  );
  const input = join(root, "operator.json");
  const directory = join(root, "prepared");
  await writeFile(input, JSON.stringify(operator));
  const journalPath = join(root, operator.deployment.name, "setup-default.json");
  const journal = async () => JSON.parse(await readFile(journalPath, "utf8"));
  const calls: string[] = [];
  let modelReady = true;
  let targetReady = true;
  let minted: unknown;
  let oauthState = "";
  let ingested = false;
  const answers = [
    "0",
    "first-agent",
    "client",
    "client",
    "yes",
    "yes",
    "",
    "",
    "",
    "agents.read,conversations.create",
    "",
    "",
    "",
    "login",
    "yes",
  ];
  const interaction: AuthInteraction = {
    async prompt(prompt) {
      if (prompt.type === "select" && prompt.options.some((o) => o.id === "copy_code"))
        return "copy_code";
      if (prompt.type === "manual_code") return `synthetic-code#${oauthState}`;
      const answer = answers.shift();
      assert.notEqual(answer, undefined, "unexpected setup question");
      return answer as string;
    },
    async notify(event) {
      if (event.type === "auth_url")
        oauthState = new URL(event.url).searchParams.get("state") ?? "";
      assert.equal(JSON.stringify(event).includes("synthetic-issued-token"), false);
    },
  };
  const scope = emptyScope();
  const workspace = {
    workspaceId: "workspace-first",
    bindingVersion: 1,
    config: operator.runtime.workspace,
    revision: "0",
    manifestHash: "a".repeat(64),
    availability: "available",
  };
  const agent = {
    agentId: "agent-first",
    name: "first-agent",
    configVersion: 1,
    model: { providerId: "cloudflare", modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    status: "idle",
  };
  const protocol = (): Protocol => ({
    protocolVersion: "1.0",
    schemaVersion: "1.0.0",
    deploymentId: "actual-authority-id",
    supportedVersions: ["1.0"],
    features: [],
    schemas: [],
    models: operator.runtime.models.map((m) => ({
      providerId: m.providerId,
      modelId: m.modelId,
      capabilities: [],
      available: modelReady,
    })),
    infrastructure: operator.runtime.infrastructure,
    limits: {
      jsonBytes: 1048576,
      outputFrameBytes: 16384,
      chunkBytes: 1024,
      uploadTtlMs: 60000,
      ticketTtlMs: 10000,
      rpcDeadlineMs: 1000,
      replayPage: 100,
      socketBufferBytes: 65536,
      socketBufferFrames: 16,
    },
    retention: { kind: "conversation-lifetime", retainedFloor: 0 },
    backends: [{ kind: "native", available: true, confinement: "host" }],
  });
  const response = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const context: CommandContext = {
    profileDirectory: root,
    signal: new AbortController().signal,
    interaction,
    wrangler: {
      async run(request) {
        const state = await journal();
        assert.ok(
          state.setupId &&
            state.plan.workspace.requestId &&
            state.plan.agent.requestId &&
            state.plan.credential.requestId,
          "IDs must persist before Wrangler effects",
        );
        assert.equal(JSON.stringify(state).includes("synthetic-issued-token"), false);
        const kind = request.args.slice(0, 2).join(" ");
        if (request.args[0] === "login") {
          calls.push("wrangler:login");
          assert.equal(state.pending.stage, "login");
          return "";
        }
        if (kind === "secret list") {
          calls.push("wrangler:names");
          return JSON.stringify([
            { name: "EXISTING_PROVIDER_KEY" },
            { name: "FORTIPI_MODEL_AUTH_KEY" },
          ]);
        }
        if (kind === "secret put") {
          calls.push("wrangler:bootstrap");
          assert.equal(
            request.args[2],
            "FORTIPI_ADMIN_TOKEN",
            "an existing provider key must never be replaced",
          );
          const profile = (await readProtected(join(root, "default.json"))) as { token: string };
          assert.ok(
            request.input === profile.token && !request.args.includes(profile.token),
            "persisted bootstrap travels only through stdin",
          );
          assert.equal(state.pending.stage, "deploy");
          return "";
        }
        assert.equal(request.args[0], "deploy");
        calls.push("wrangler:deploy");
        assert.equal(state.pending.stage, "deploy");
        if (fault === "deploy") throw new Error("synthetic reply lost after remote deployment");
        assert.ok(request.outputFile);
        await writeFile(
          request.outputFile,
          `${JSON.stringify({
            type: "deploy",
            version: 1,
            worker_name: operator.deployment.name,
            version_id: "12345678-1234-4234-8234-123456789abc",
            targets: [operator.deployment.origin],
          })}\n`,
        );
        return "";
      },
    },
    transport: async (url, init) => {
      const target = new URL(String(url));
      assert.equal(target.origin, operator.deployment.origin);
      if (target.pathname === "/health") return response({ status: "ok", protocolVersion: "1.0" });
      calls.push(`${init?.method}:${target.pathname}`);
      const profile = (await readProtected(join(root, "default.json"))) as { token: string };
      assert.ok(
        new Headers(init?.headers).get("authorization") === `Bearer ${profile.token}`,
        "exact protected bootstrap identity required",
      );
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (target.pathname === "/v1/admin/models/anthropic/auth") {
        if (init?.method === "GET")
          return response({
            providerId: "anthropic",
            version: ingested ? 1 : null,
            generation: ingested ? 1 : 0,
            state: ingested ? "configured" : "absent",
          });
        assert.equal(init?.method, "PUT");
        const state = await journal();
        assert.equal(state.pending.stage, "provider");
        assert.equal(body.requestId, state.pending.requestId);
        assert.equal(body.credential.access, "synthetic-oauth-access");
        assert.equal(body.credential.refresh, "synthetic-oauth-refresh");
        assert.equal(JSON.stringify(state).includes(body.credential.access), false);
        ingested = true;
        return response({
          providerId: "anthropic",
          version: 1,
          generation: 1,
          state: "configured",
        });
      }
      if (init?.method === "POST") {
        const state = await journal();
        assert.equal(
          state.pending.requestId,
          body.requestId,
          "intent must be on disk before the transport sees a mutation",
        );
        if (target.pathname === "/v1/workspaces") {
          assert.deepEqual(body, state.plan.workspace);
          return response(workspace, 201);
        }
        if (target.pathname === "/v1/agents") {
          assert.deepEqual(body, state.plan.agent);
          return response(agent, 201);
        }
        assert.equal(target.pathname, "/v1/admin/credentials");
        assert.deepEqual(body.grants[0].resources, {
          ...scope,
          agentIds: [agent.agentId],
          workspaceIds: [workspace.workspaceId],
          actions: ["agents.read", "conversations.create"],
        });
        assert.equal(body.role, "client");
        const reservation = (await readProtected(join(root, "client.json"))) as {
          requestId: string;
          state: string;
        };
        assert.equal(reservation.requestId, body.requestId);
        assert.equal(reservation.state, "pending");
        minted = body;
        if (fault === "credential") throw new Error("synthetic one-time response lost");
        return response(
          {
            credential: { credentialId: "credential-first", generation: 1, grantVersion: 1 },
            role: "client",
            state: "issued",
            token: "synthetic-issued-token",
          },
          201,
        );
      }
      if (target.pathname === "/v1/protocol") return response(protocol());
      if (target.pathname === "/v1/admin/configuration") return response(operator.runtime);
      if (target.pathname === "/v1/workspaces/workspace-first") return response(workspace);
      if (target.pathname === "/v1/agents/agent-first") return response(agent);
      if (target.pathname === "/v1/executors")
        return response({
          items: ["my-device", "workspace-device"].map((executorId) => ({
            executorId,
            ledgerId: `${executorId}-ledger`,
            ledgerInstanceId: `${executorId}-instance`,
            generation: 1,
            connectionEpoch: 1,
            platform: "linux",
            caseBehavior: "sensitive",
            confinement: "host",
            capabilities: [],
            rootBindingIds: ["workspace-root"],
            state: targetReady ? "online" : "offline",
            transferLimits: {
              chunkBytes: 1024,
              fileBytes: 1024,
              snapshotBytes: 1024,
              artifactBytes: 1024,
              manifestEntries: 10,
            },
          })),
        });
      assert.fail(`unexpected controlled route ${target.pathname}`);
    },
  };
  const run = async (nonInteractive = false) =>
    (await runCommand(
      [
        "setup",
        "--config",
        input,
        "--directory",
        directory,
        ...(nonInteractive ? ["--non-interactive"] : []),
      ],
      context,
    )) as SetupResult;
  return {
    root,
    input,
    directory,
    calls,
    context,
    run,
    journal,
    answers,
    minted: () => minted,
    models: (value: boolean) => {
      modelReady = value;
    },
    targets: (value: boolean) => {
      targetReady = value;
    },
  };
}

test("guided setup composes real commands with persisted explicit grants, readiness waits and mutation-free resume", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.run(true), /setup_choices_require_terminal/);
  assert.equal(h.calls.length, 0, "canonical config alone cannot authorize initial grants");
  h.models(false);
  const waiting = await h.run();
  assert.equal(waiting.state, "setup-pending");
  assert.equal(waiting.reason, "selected_model_not_ready");
  assert.equal(
    h.calls.some((c) => c.startsWith("POST:")),
    false,
  );
  assert.equal(h.answers.length, 0);
  h.models(true);
  h.targets(false);
  const registered = await h.run(true);
  assert.equal(registered.state, "setup-pending");
  assert.equal(registered.reason, "workspace_or_execution_target_not_ready");
  assert.ok(h.minted());
  h.targets(true);
  const complete = await h.run(true);
  assert.equal(complete.state, "setup-completed");
  assert.equal(h.calls.filter((c) => c === "wrangler:deploy").length, 1);
  assert.equal(h.calls.filter((c) => c.startsWith("POST:")).length, 3);
  const delivered = (await readProtected(join(h.root, "client.json"))) as { token: string };
  assert.ok(delivered.token === "synthetic-issued-token");
  assert.equal(JSON.stringify(complete).includes(delivered.token), false);
  assert.equal(JSON.stringify(await h.journal()).includes(delivered.token), false);
  const cfg = await readConfig(h.input);
  assert.equal(cfg.runtime.infrastructure.profile, "free");
  const prepared = JSON.parse(await readFile(join(h.directory, "wrangler.json"), "utf8"));
  assert.equal(prepared.containers, undefined);
  assert.equal(prepared.worker_loaders, undefined);
});

test("lost deployment and one-time credential replies preserve identities and refuse blind replay", async (t) => {
  for (const fault of ["deploy", "credential"] as const) {
    const h = await harness(t, fault);
    const first = await h.run();
    assert.equal(first.state, "setup-uncertain");
    assert.equal(first.exitCode, 1);
    const before = await h.journal();
    assert.equal(before.pending.stage, fault);
    const identity = await readProtected(join(h.root, "default.json"));
    const mutations = h.calls.filter(
      (c) => c.startsWith("POST:") || c.startsWith("wrangler:"),
    ).length;
    const second = await h.run(true);
    assert.equal(second.state, "setup-uncertain");
    assert.equal(second.setupId, first.setupId);
    assert.equal(second.requestId, first.requestId);
    assert.deepEqual(await readProtected(join(h.root, "default.json")), identity);
    assert.equal(
      h.calls.filter((c) => c.startsWith("POST:") || c.startsWith("wrangler:")).length,
      mutations,
    );
    assert.equal(JSON.stringify(await h.journal()).includes("synthetic-issued-token"), false);
  }
});

test("guided provider readiness uses the real Pi copy-code flow and preserves an unknown existing model-auth key", async (t) => {
  const h = await harness(t, undefined, true);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let exchanges = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://platform.claude.com/v1/oauth/token");
    exchanges++;
    return Response.json({
      access_token: "synthetic-oauth-access",
      refresh_token: "synthetic-oauth-refresh",
      expires_in: 3600,
    });
  };
  const ready = await h.run();
  assert.equal(ready.state, "setup-completed");
  assert.equal(exchanges, 1);
  assert.equal(h.calls.filter((c) => c === "PUT:/v1/admin/models/anthropic/auth").length, 1);
  assert.equal(JSON.stringify(await h.journal()).includes("synthetic-oauth-"), false);
  await assert.rejects(readFile(join(h.root, "fortipi-example/model-auth-key.json")), {
    code: "ENOENT",
  });
  assert.equal((await h.run(true)).state, "setup-completed");
  assert.equal(exchanges, 1, "acknowledged setup must not start another provider login");
});

test("interactive init uses an actual terminal; pipe/noninteractive inputs fail closed and cancellation writes no config", {
  timeout: 15000,
}, async (t) => {
  const root = await temp(t);
  assert.equal(
    argv(["setup", "--config", "operator.json", "--directory", "prepared"]).command,
    "setup",
  );
  for (const command of ["init", "setup"]) {
    for (const mode of [[], ["--non-interactive"]]) {
      await assert.rejects(
        execute(
          process.execPath,
          [
            bin,
            command,
            "--config",
            join(root, "blocked.json"),
            ...(command === "setup" ? ["--directory", join(root, "blocked")] : []),
            ...mode,
          ],
          { timeout: 3000 },
        ),
        (e: unknown) => {
          const error = e as { stderr: string };
          assert.match(
            error.stderr,
            /interactive_terminal_required|setup_choices_require_terminal/,
          );
          return true;
        },
      );
    }
  }
  const input = join(root, "interactive.json");
  const replies = [
    "guided-example",
    "https://guided.example.workers.dev",
    "",
    "cloudflare",
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "local",
    "workspace-device",
    "workspace-root",
    "native",
    "execution-device",
    "host",
    "explicit",
    "execution-device",
    "yes",
  ];
  const prompts = [
    "Deployment name",
    "Exact HTTPS",
    "Cloudflare account ID",
    "Model provider",
    "Model ID",
    "Workspace storage",
    "Workspace executor ID",
    "Workspace root binding ID",
    "Execution backend",
    "Execution executor ID",
    "Registered executor confinement",
    "Routing preference",
    "Routing target IDs",
    "Write this configuration?",
  ];
  async function terminal(path: string, cancel: boolean) {
    const child = ptySpawn(process.execPath, [bin, "init", "--config", path, "--json"], {
      name: "xterm-256color",
      cols: 120,
      rows: 50,
      cwd: root,
      env: { PATH: process.env.PATH ?? "", TERM: "xterm-256color", LANG: "C" },
    });
    let output = "",
      at = 0;
    const timer = setTimeout(() => child.kill(), 10000);
    const completion = new Promise<number>((accept) =>
      child.onExit(({ exitCode }) => accept(exitCode)),
    );
    child.onData((bytes) => {
      output += bytes;
      if (output.includes(prompts[at] ?? "never-matching-complete")) {
        child.write(cancel ? "\u0003" : `${replies[at]}\r`);
        at++;
      }
    });
    const code = await completion;
    clearTimeout(timer);
    assert.equal(code, cancel ? 130 : 0, output);
    return output;
  }
  const output = await terminal(input, false);
  assert.match(output, /"state":"initialized"/);
  const created = await readConfig(input);
  assert.deepEqual(created.runtime.workspace, {
    kind: "local",
    executorId: "workspace-device",
    rootBindingId: "workspace-root",
  });
  assert.deepEqual(created.runtime.execution, {
    kind: "native",
    executorId: "execution-device",
    trust: "host",
  });
  assert.equal(created.runtime.infrastructure.profile, "free");
  const cancelled = join(root, "cancelled.json");
  await terminal(cancelled, true);
  await assert.rejects(readFile(cancelled), { code: "ENOENT" });
});
