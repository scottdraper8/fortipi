import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "fortipi-contract";
import {
  ExecutorRuntime,
  HttpTransport,
  hash,
  SessionTransport,
} from "../../../../packages/fortipi-executor/dist/index.js";
import {
  fixture,
  nodeCommand,
} from "../../../../packages/fortipi-executor/test/fixtures/daemon.ts";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "../agent/harness.ts";
import type { TestAgentSession } from "../agent/runtime-worker.js";
import { computerBase } from "./computer-base.ts";

/** Real public service + native executor; only the provider is synthetic. */
export async function nativeService(
  options: {
    free?: boolean;
    changed?: boolean;
    holdCommit?: boolean;
    computer?: boolean;
    computerFiles?: number;
    localConsent?: boolean;
    approve?: boolean;
    maximumToolModel?: boolean;
    observeHttp?: (value: {
      path: string;
      method: string;
      status: number;
      code?: string;
      retryAfterMs?: number;
      message?: string;
      pressure?: D.InfrastructurePressure;
    }) => void;
  } = {},
) {
  const h = await harness({
      ...(options.free ? { traffic: "free" as const } : {}),
      ...(options.maximumToolModel ? { modelChunkBytes: 256 as const } : {}),
    }),
    f = await fixture(),
    stop = new AbortController();
  let runtime: ExecutorRuntime | undefined, connection: Promise<void> | undefined;
  let releaseCommit: (() => Promise<void>) | undefined;
  const gate = join(f.path, "release-process"),
    marker = join(f.path, "process-starts");
  const close = async () => {
    await releaseCommit?.();
    await writeFile(gate, "finish").catch(() => {});
    stop.abort();
    await connection;
    await runtime?.shutdown();
    await h.close();
    await f.cleanup();
  };
  try {
    const { agent, conversation } = await setup(h),
      executorId = crypto.randomUUID();
    const issue = async (role: "client" | "executor", resources: D.ResourceScope) => {
      const result = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
        requestId: crypto.randomUUID(),
        role,
        ...(role === "executor" ? { executorId } : {}),
        expiresAt: Date.now() + 180000,
        grants: [{ grantId: crypto.randomUUID(), version: 1, resources }],
      });
      assert.equal(result.status, 201);
      if (result.body.state !== "issued") assert.fail("Expected local synthetic credential");
      return result.body;
    };
    const empty: D.ResourceScope = {
      agentIds: [],
      conversationIds: [],
      workspaceIds: [],
      executorIds: [executorId],
      backendIds: [],
      tools: [],
      actions: ["tickets.mint", "executors.register"],
    };
    const bootstrap = await issue("executor", empty);
    const seeded = await h.api(
      "/v1/connections/tickets",
      {
        requestId: crypto.randomUUID(),
        audience: "executor-session",
        resources: empty,
        originMode: { kind: "native" },
        executor: { executorId, generation: 1 },
      },
      "POST",
      bootstrap.token,
    );
    assert.equal(seeded.status, 201);
    let created = await h.api<D.WorkspaceBinding>("/v1/workspaces", {
      requestId: crypto.randomUUID(),
      config: options.computer
        ? { kind: "computer" }
        : { kind: "local", executorId, rootBindingId: "root" },
    });
    assert.equal(created.status, 201);
    const workspaceId = created.body.workspaceId;
    if (options.computerFiles) {
      assert.equal(options.computer, true);
      const writer = await issue("client", {
        agentIds: [],
        conversationIds: [],
        workspaceIds: [workspaceId],
        tools: [],
        executorIds: [],
        backendIds: [workspaceId],
        actions: ["workspace.write"],
      });
      created = {
        ...created,
        body: await computerBase(h, created.body, writer.token, options.computerFiles),
      };
    }
    const resources: D.ResourceScope = {
      agentIds: [agent.agentId],
      conversationIds: [conversation.conversationId],
      workspaceIds: [workspaceId],
      executorIds: [executorId],
      backendIds: [],
      tools: ["shell"],
      actions: [
        "tickets.mint",
        "executors.register",
        "transfers.input",
        "transfers.output",
        "transfers.status",
        "workspace.read",
        "workspace.write",
        "artifacts.read",
      ],
    };
    const executor = await issue("executor", resources),
      { url } = await h.server.listen(),
      protocol = await h.api<D.Protocol>("/v1/protocol");
    assert.equal(protocol.status, 200);
    Object.assign(f.profile, {
      origin: new URL(url).origin,
      deploymentId: protocol.body.deploymentId,
      executorId,
      executorGeneration: 1,
      credential: executor.credential,
      token: executor.token,
      resources,
    });
    f.profile.bindings = [
      {
        rootBindingId: "root",
        workspaceId,
        bindingVersion: options.computer ? created.body.bindingVersion : 2,
        path: f.rootPath,
        revision: options.computer ? created.body.revision : "imported_base",
        manifestHash: options.computer ? created.body.manifestHash : f.initial.manifestHash,
        providerKind: options.computer ? "computer" : "local",
      },
    ];
    const script = options.changed
      ? `import{appendFileSync,writeFileSync}from'node:fs';appendFileSync(${JSON.stringify(marker)},'start\\n');writeFileSync('native-result.txt','actual native change');process.stdout.write('changed');`
      : `import{appendFileSync,existsSync}from'node:fs';appendFileSync(${JSON.stringify(marker)},'start\\n');const timer=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})){clearInterval(timer);process.stdout.write('done');}},50);`;
    const command = nodeCommand("--input-type=module", "-e", script);
    const operationArguments = {
      command,
      ...(options.maximumToolModel ? { padding: "a".repeat(62000) } : {}),
    };
    f.profile.policy.rules =
      options.localConsent === false
        ? []
        : [
            {
              workspaceId,
              rootBindingId: "root",
              tool: "shell",
              argumentDigest: hash(canonicalJson(operationArguments)),
            },
          ];
    runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http: new HttpTransport(
        f.profile,
        options.observeHttp
          ? async (input, init) => {
              const response = await fetch(input, init);
              const failure =
                response.status >= 400
                  ? ((await response
                      .clone()
                      .json()
                      .catch(() => undefined)) as D.ErrorBody | undefined)
                  : undefined;
              options.observeHttp?.({
                path: new URL(input instanceof Request ? input.url : String(input)).pathname,
                method: init?.method ?? (input instanceof Request ? input.method : "GET"),
                status: response.status,
                ...(failure?.error?.code ? { code: failure.error.code } : {}),
                ...(failure?.error?.message ? { message: failure.error.message } : {}),
                ...(failure?.error?.details?.retryAfterMs !== undefined
                  ? { retryAfterMs: failure.error.details.retryAfterMs }
                  : {}),
                ...(failure?.error?.details?.pressure
                  ? { pressure: failure.error.details.pressure }
                  : {}),
              });
              return response;
            }
          : fetch,
        true,
      ),
    });
    await runtime.initialize();
    if (!options.computer) {
      const local = runtime.locals.get("root");
      assert.ok(local);
      await local.importBinding(local.importProposal(crypto.randomUUID()));
    }
    const session = new SessionTransport(runtime.http, runtime);
    runtime.session = session;
    connection = session
      .connect(stop.signal, {
        type: "executor.register",
        requestId: crypto.randomUUID(),
        payload: {
          executorId,
          generation: 1,
          protocolVersion: "1.0",
          schemaVersion: "1.0.0",
          platform: process.platform as "darwin" | "linux" | "win32",
          caseBehavior: f.root.identity.caseBehavior,
          confinement: "host",
          capabilities: ["shell", "local-workspace", "snapshots"],
          rootBindingIds: ["root"],
          transferLimits: runtime.http.transferLimits(),
        },
      })
      .catch(() => {});
    await eventually(
      async () => runtime!.connected,
      (value) => value,
    );
    let binding = created.body;
    if (!options.computer) {
      const rebound = await h.api<D.WorkspaceBinding>(
        `/v1/workspaces/${workspaceId}`,
        {
          requestId: crypto.randomUUID(),
          expectedVersion: 1,
          newBindingVersion: 2,
          config: { kind: "local", executorId, rootBindingId: "root" },
          import: {
            revision: "imported_base",
            manifest: f.initial.manifest,
            acknowledgeExternalEffects: true,
          },
        },
        "PATCH",
      );
      assert.equal(rebound.status, 200);
      binding = rebound.body;
    }
    const actor = await issue("client", {
      ...resources,
      actions: [
        "messages.submit",
        "conversations.read",
        "tasks.read",
        "jobs.dispatch",
        "workspace.write",
        "approvals.read",
        "approvals.decide",
        ...(options.maximumToolModel ? ["tasks.cancel"] : []),
      ],
    });
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    if (options.holdCommit) {
      await probe.holdNativeCommit();
      releaseCommit = () => probe.releaseNativeCommit();
    }
    const toolInput = JSON.stringify({
      tool: "shell",
      arguments: operationArguments,
      workspaceId,
      baseRevision: binding.revision,
      target: { kind: "executor", executorId, generation: f.profile.executorGeneration },
      capabilities: ["shell"],
    });
    if (options.maximumToolModel) {
      await probe.queueNearLimitRounds(toolInput);
      await probe.releaseCompletion();
    } else await probe.queueTool(toolInput);
    const input: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "run actual native process",
      busyBehavior: "followUp",
    };
    const sent = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      input,
      "POST",
      actor.token,
    );
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const state = async () =>
      JSON.parse(await probe.toolStateJson(conversation.conversationId)) as Awaited<
        ReturnType<TestAgentSession["toolState"]>
      >;
    let waiting: Awaited<ReturnType<typeof state>>;
    try {
      waiting = await eventually(state, (value) => value.jobs[0]?.approvalId != null);
    } catch (error) {
      if (options.maximumToolModel) {
        const inspection = JSON.parse(
          await probe.inspectionJson(conversation.conversationId),
        ) as Awaited<ReturnType<TestAgentSession["inspectConversation"]>>;
        console.log(
          JSON.stringify({
            maximumModelBeforeApproval: {
              jobs: (await state()).jobs.map((job) => ({
                state: job.state,
                approvalId: job.approvalId,
              })),
              entries: inspection.entries.map((entry) => ({
                kind: entry.kind,
                assistantBytes: entry.assistantBytes,
                toolArgumentBytes: entry.toolArgumentBytes,
                boundedModelFailure: entry.boundedModelFailure,
              })),
              run: JSON.parse(await probe.runPolicy(conversation.conversationId)),
            },
          }),
        );
      }
      throw error;
    }
    const job = waiting.jobs[0];
    assert.ok(job?.approvalId);
    const approval = await h.api<D.Approval>(
      `/v1/approvals/${job.approvalId}`,
      undefined,
      "GET",
      actor.token,
    );
    assert.equal(approval.status, 200);
    if (options.approve !== false) {
      const approved = await h.api(
        `/v1/approvals/${job.approvalId}/decisions`,
        {
          requestId: crypto.randomUUID(),
          expectedVersion: approval.body.version,
          operationDigest: approval.body.operation.operationDigest,
          decision: "approve",
        },
        "POST",
        actor.token,
      );
      assert.equal(approved.status, 200);
    }
    return {
      h,
      f,
      runtime,
      probe,
      agent,
      conversation,
      workspaceId,
      actor,
      sent,
      input,
      job,
      state,
      marker,
      gate,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
