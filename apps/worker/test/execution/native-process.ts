import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { build } from "esbuild";
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
import { eventually, pause } from "../agent/harness.ts";
import { processHarness } from "../agent/process-harness.ts";

interface View {
  tasks: { id: number; kind: string; status: string }[];
  jobs: {
    jobId: string;
    state: D.JobState;
    approvalId: string | null;
    operationId: string;
    operationDigest: string;
    rootBindingId: string | null;
    baseManifestHash: string | null;
    executorTransferLimits: D.ExecutorTransferLimits | null;
  }[];
}

/** Real service/process recovery; safe annotation remains in the disposable build. */
export async function nativeProcessRecovery(
  mode:
    | "running"
    | "seed"
    | "attached"
    | "attempted"
    | "assign-ack"
    | "result"
    | "receipt" = "running",
  activation: "agent-first" | "executor-first" = "agent-first",
) {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-native-service-kill-")),
    main = join(directory, "worker.js"),
    f = await fixture(),
    stop = new AbortController(),
    marker = join(f.path, "process-starts"),
    gate = join(f.path, "release-process");
  let h: Awaited<ReturnType<typeof processHarness>> | undefined,
    runtime: ExecutorRuntime | undefined,
    connection: Promise<void> | undefined;
  try {
    let candidates = 0;
    let phaseBarriers = 0;
    await build({
      entryPoints: [resolve("apps/worker/test/agent/runtime-worker.ts")],
      outfile: main,
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["browser", "module", "main"],
      target: "es2024",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*", ...builtinModules],
      loader: { ".yaml": "json" },
      logLevel: "silent",
      plugins: [
        {
          name: "owned-candidate-safe-wrapper",
          setup(builder) {
            builder.onLoad({ filter: /test\/agent\/runtime-worker\.ts$/ }, async (args) => {
              if (mode !== "assign-ack") return;
              let contents = await readFile(args.path, "utf8");
              const method = "  override reserveCapacity(",
                fetch = "    const path = new URL(request.url).pathname;",
                route = '    if (url.pathname === "/__test/ping") return new Response("ready");';
              for (const needle of [method, fetch, route])
                assert.equal(contents.split(needle).length, 2);
              contents = contents.replace(
                method,
                `
                override async assignOnce(ctx: D.AuthContext, input: D.Assignment) {
                  const result = await super.assignOnce(ctx, input);
                  if (result.ok && this.store.get("fixture", "assign-ack") === "armed") {
                    this.store.put("fixture", "assign-ack", "held");
                    await new Promise(resolve => setTimeout(resolve, 300000));
                  }
                  return result;
                }
                ${method}`,
              );
              contents = contents.replace(
                fetch,
                `${fetch}
                if (path === "/__test/assign-ack") {
                  if (request.method === "PUT") this.store.put("fixture", "assign-ack", "armed");
                  return Response.json({ state: this.store.get("fixture", "assign-ack") ?? null });
                }`,
              );
              contents = contents.replace(
                route,
                `${route}
                if (url.pathname === "/__test/assign-ack")
                  return env.CONTROL_PLANE.getByName("control").fetch(request);`,
              );
              return { contents, loader: "ts" };
            });
            builder.onLoad({ filter: /src\/execution\/dispatch\.ts$/ }, async (args) => {
              if (!["attempted", "result", "receipt"].includes(mode)) return;
              const source = await readFile(args.path, "utf8");
              const needle =
                mode === "attempted"
                  ? "await this.jobs.authority.control.assignOnce(this.auth(state), assignment);"
                  : mode === "result"
                    ? "async commitResult(state: JobState): Promise<void> {"
                    : "unwrap(await this.jobs.finalize(auth, evidence));";
              assert.equal(source.split(needle).length, 2);
              phaseBarriers++;
              const barrier = `
                if (await this.jobs.store.get("fixture", "fault") === "${mode}") {
                  await this.jobs.store.transaction(async tx => {
                    await this.jobs.store.remove("fixture", "fault", tx);
                    await this.jobs.store.put("fixture", "barrier", "${mode}", tx);
                  });
                  await new Promise(resolve => setTimeout(resolve, 300000));
                }`;
              return {
                loader: "ts",
                contents: source.replace(
                  needle,
                  mode === "result" ? `${needle}\n${barrier}` : `${barrier}\n${needle}`,
                ),
              };
            });
            builder.onLoad({ filter: /src\/execution\/registry\.ts$/ }, async (args) => {
              const source = await readFile(args.path, "utf8"),
                needle = 'replay: "unsafe"';
              assert.equal(source.split(needle).length, 2);
              candidates++;
              let contents = source.replace(needle, 'replay: "safe"');
              if (mode === "attached") {
                const attached = "context.abortSignal?.throwIfAborted();";
                assert.equal(contents.split(attached).length, 2);
                contents = contents.replace(
                  attached,
                  `
                  if (await jobs.store.get("fixture", "fault") === "after-attach") {
                    await jobs.store.transaction(async tx => {
                      await jobs.store.remove("fixture", "fault", tx);
                      await jobs.store.put("fixture", "barrier", "after-attach", tx);
                    });
                    await new Promise(resolve => setTimeout(resolve, 300000));
                  }
                  ${attached}`,
                );
              }
              return { loader: "ts", contents };
            });
          },
        },
      ],
    });
    assert.equal(candidates, 1);
    assert.equal(phaseBarriers, ["attempted", "result", "receipt"].includes(mode) ? 1 : 0);
    h = await processHarness(main);
    const service = h;
    const agent = await service.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "native-process-recovery",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201);
    const conversation = await service.api<D.Conversation>(
      `/v1/agents/${agent.body.agentId}/conversations`,
      { requestId: crypto.randomUUID() },
    );
    assert.equal(conversation.status, 201);
    const agentId = agent.body.agentId,
      cid = conversation.body.conversationId,
      probe = `/__test/agents/${agentId}`,
      executorId = crypto.randomUUID();
    const issue = async (role: "client" | "executor", resources: D.ResourceScope) => {
      const result = await service.api<D.CredentialReceipt>("/v1/admin/credentials", {
        requestId: crypto.randomUUID(),
        role,
        grants: [{ grantId: crypto.randomUUID(), version: 1, resources }],
        ...(role === "executor" ? { executorId } : {}),
        expiresAt: Date.now() + 300000,
      });
      assert.equal(result.status, 201);
      if (result.body.state !== "issued") assert.fail("Synthetic scoped credential required");
      return result.body;
    };
    const bootstrapScope: D.ResourceScope = {
      agentIds: [],
      conversationIds: [],
      workspaceIds: [],
      executorIds: [executorId],
      backendIds: [],
      tools: [],
      actions: ["tickets.mint", "executors.register"],
    };
    const bootstrap = await issue("executor", bootstrapScope);
    assert.equal(
      (
        await service.api(
          "/v1/connections/tickets",
          {
            requestId: crypto.randomUUID(),
            audience: "executor-session",
            resources: bootstrapScope,
            originMode: { kind: "native" },
            executor: { executorId, generation: 1 },
          },
          "POST",
          bootstrap.token,
        )
      ).status,
      201,
    );
    const workspace = await service.api<D.WorkspaceBinding>("/v1/workspaces", {
      requestId: crypto.randomUUID(),
      config: { kind: "local", executorId, rootBindingId: "root" },
    });
    assert.equal(workspace.status, 201);
    const workspaceId = workspace.body.workspaceId;
    const resources: D.ResourceScope = {
      agentIds: [agentId],
      conversationIds: [cid],
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
      protocol = await service.api<D.Protocol>("/v1/protocol");
    assert.equal(protocol.status, 200);
    Object.assign(f.profile, {
      origin: service.origin,
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
        bindingVersion: 2,
        path: f.rootPath,
        revision: "imported_base",
        manifestHash: f.initial.manifestHash,
        providerKind: "local",
      },
    ];
    const command = nodeCommand(
      "--input-type=module",
      "-e",
      `import{appendFileSync,existsSync,writeFileSync}from'node:fs';appendFileSync(${JSON.stringify(marker)},'start\\n');const timer=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})){clearInterval(timer);writeFileSync('process-result.txt','changed after service loss');process.stdout.write('done');}},50);`,
    );
    f.profile.policy.rules = [
      {
        workspaceId,
        rootBindingId: "root",
        tool: "shell",
        argumentDigest: hash(canonicalJson({ command })),
      },
    ];
    runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http: new HttpTransport(f.profile, fetch, true),
    });
    await runtime.initialize();
    const local = runtime.locals.get("root");
    assert.ok(local);
    await local.importBinding(local.importProposal(crypto.randomUUID()));
    const native = runtime;
    const connect = async () => {
      const session = new SessionTransport(native.http, native);
      native.session = session;
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
            transferLimits: native.http.transferLimits(),
          },
        })
        .catch(() => {});
      await eventually(async () => native.connected, Boolean);
    };
    await connect();
    const rebound = await service.api<D.WorkspaceBinding>(
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
    const actor = await issue("client", {
      ...resources,
      actions: [
        "messages.submit",
        "jobs.dispatch",
        "workspace.write",
        "approvals.read",
        "approvals.decide",
      ],
    });
    const canary = { nonce: crypto.randomUUID() };
    await service.api(`${probe}/canary`, canary, "PUT");
    if (["attempted", "assign-ack", "result", "receipt"].includes(mode))
      await service.api("/__test/dispatch-trace", {}, "PUT");
    if (mode === "seed") await service.api(`${probe}/fault`, "after-seed");
    if (mode === "attached") await service.api(`${probe}/fault`, "after-attach");
    if (["attempted", "result", "receipt"].includes(mode))
      await service.api(`${probe}/fault`, mode);
    if (mode === "assign-ack") await service.api("/__test/assign-ack", {}, "PUT");
    await service.api(`${probe}/tool`, {
      tool: "shell",
      arguments: { command },
      workspaceId,
      baseRevision: rebound.body.revision,
      target: { kind: "executor", executorId, generation: 1 },
      capabilities: ["shell"],
    });
    const input: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "survive service loss",
      busyBehavior: "followUp",
    };
    const sent = await service.api<D.AdmissionReceipt>(
      `/v1/conversations/${cid}/messages`,
      input,
      "POST",
      actor.token,
    );
    assert.equal(sent.status, 202);
    const view = async () => (await service.api<View>(`${probe}/tool-state?cid=${cid}`)).body;
    const phaseBarrier = async (phase: string) => {
      for (let i = 0; i < 600; i++) {
        await native.tick();
        const actual = await service.api<{ barrier: string | null }>(`${probe}/state`);
        if (actual.body.barrier === phase) return;
        await pause(50);
      }
      assert.fail(JSON.stringify({ phase, application: await view() }));
    };
    let seeded: View["jobs"][number] | undefined;
    if (mode === "seed" || mode === "attached") {
      const point = mode === "seed" ? "after-seed" : "after-attach";
      await eventually(
        async () => (await service.api<{ barrier: string | null }>(`${probe}/state`)).body,
        (value) => value.barrier === point,
      );
      const before = await view();
      assert.equal(before.jobs.length, 1);
      const beforeChildren = before.tasks
        .filter((task) => task.kind === "fortipi.dispatch")
        .map((task) => task.id);
      assert.equal(beforeChildren.length, mode === "seed" ? 0 : 1);
      assert.equal(
        await readFile(marker, "utf8").catch(() => ""),
        "",
        "No execution before approval",
      );
      seeded = before.jobs[0];
      assert.ok(seeded);
      await service.crash();
      await connection;
      await service.start();
      assert.deepEqual((await service.api(`${probe}/canary`)).body, canary);
      await connect();
      const recovered = await view();
      if (mode === "attached")
        assert.deepEqual(
          recovered.tasks.filter((task) => task.kind === "fortipi.dispatch").map((task) => task.id),
          beforeChildren,
          "Atomic child reference survives death before wrapper wait, with no second child",
        );
      const actual = recovered.jobs[0];
      assert.ok(actual);
      assert.equal(actual.jobId, seeded.jobId);
      assert.equal(actual.operationId, seeded.operationId);
      assert.equal(actual.operationDigest, seeded.operationDigest);
      assert.equal(
        actual.rootBindingId,
        "root",
        "Seed acknowledgement must already include the validated local root",
      );
      assert.equal(actual.baseManifestHash, f.initial.manifestHash);
      assert.ok(actual.executorTransferLimits);
    }
    const waiting = await eventually(view, (value) => !!value.jobs[0]?.approvalId),
      job = waiting.jobs[0];
    assert.ok(job?.approvalId);
    const approval = await service.api<D.Approval>(
      `/v1/approvals/${job.approvalId}`,
      undefined,
      "GET",
      actor.token,
    );
    assert.equal(approval.status, 200);
    assert.equal(
      (
        await service.api(
          `/v1/approvals/${job.approvalId}/decisions`,
          {
            requestId: crypto.randomUUID(),
            expectedVersion: approval.body.version,
            operationDigest: approval.body.operation.operationDigest,
            decision: "approve",
          },
          "POST",
          actor.token,
        )
      ).status,
      200,
    );
    if (mode === "attempted") {
      await phaseBarrier("attempted");
      const before = await service.api<D.Job>(`/v1/jobs/${job.jobId}`);
      assert.equal(before.status, 200);
      assert.equal(before.body.state, "dispatch_attempted");
      assert.ok(before.body.execution);
      const beforeChildren = (await view()).tasks
        .filter((task) => task.kind === "fortipi.dispatch")
        .map((task) => task.id);
      assert.equal(beforeChildren.length, 1);
      assert.equal(await readFile(marker, "utf8").catch(() => ""), "");
      await service.crash();
      await connection;
      await service.start();
      assert.deepEqual((await service.api(`${probe}/canary`)).body, canary);
      await connect();
      let uncertain = await view();
      for (let i = 0; i < 900 && uncertain.jobs[0]?.state !== "requires_reconciliation"; i++) {
        await native.tick();
        await pause(50);
        uncertain = await view();
      }
      assert.equal(
        uncertain.jobs[0]?.state,
        "requires_reconciliation",
        JSON.stringify({
          application: uncertain,
          diagnostic: (await service.api(`${probe}/job-diagnostics?job=${job.jobId}`)).body,
          control: (await service.api(`/__test/dispatch-trace?job=${job.jobId}`)).body,
        }),
      );
      const after = await service.api<D.Job>(`/v1/jobs/${job.jobId}`);
      assert.equal(after.body.execution?.executionId, before.body.execution.executionId);
      assert.equal(after.body.execution?.lease.fence, before.body.execution.lease.fence);
      assert.equal(after.body.operationDigest, before.body.operationDigest);
      assert.deepEqual(
        uncertain.tasks.filter((task) => task.kind === "fortipi.dispatch").map((task) => task.id),
        beforeChildren,
      );
      assert.equal(await readFile(marker, "utf8").catch(() => ""), "");
      assert.equal(
        f.ledger.get(job.jobId),
        undefined,
        "Durable absence cannot authorize an automatic assignment replay",
      );
      assert.deepEqual(
        await service.api(`/v1/conversations/${cid}/messages`, input, "POST", actor.token),
        sent,
      );
      console.log(
        JSON.stringify({
          serviceSigkill: true,
          canarySurvived: true,
          originalExecutionRetained: true,
          processStarts: 0,
          oneChild: true,
          queryOnlyUncertainty: true,
          candidateSafeOnly: true,
        }),
      );
      return;
    }
    let started = "";
    for (let i = 0; i < 600; i++) {
      await native.tick();
      started = await readFile(marker, "utf8").catch(() => "");
      if (started.includes("start")) break;
      await pause(50);
    }
    assert.ok(
      started.includes("start"),
      JSON.stringify({
        application: await view(),
        native: f.ledger.get(job.jobId)?.state,
        decision: f.ledger.get(job.jobId)?.decision,
        reason: f.ledger.get(job.jobId)?.reason,
      }),
    );
    const original = f.ledger.get(job.jobId);
    assert.ok(original);
    const identity = structuredClone(original.assignment.identity);
    const children = (await view()).tasks
      .filter((task) => task.kind === "fortipi.dispatch")
      .map((task) => task.id);
    assert.equal(children.length, 1);
    if (mode === "assign-ack") {
      await eventually(
        async () => (await service.api<{ state: string }>("/__test/assign-ack")).body,
        (value) => value.state === "held",
      );
      assert.equal((await view()).jobs[0]?.state, "dispatch_attempted");
    }
    if (mode === "running" || mode === "assign-ack") {
      await service.crash();
      await connection;
      await service.start();
      assert.deepEqual((await service.api(`${probe}/canary`)).body, canary);
      await connect();
    }
    assert.equal((await readFile(marker, "utf8")).match(/start/g)?.length, 1);
    await writeFile(gate, "finish");
    if (mode === "result" || mode === "receipt") {
      await phaseBarrier(mode);
      assert.equal((await view()).jobs[0]?.state, "result_pending_commit");
      if (mode === "receipt") {
        const binding = await service.api<D.WorkspaceBinding>(`/v1/workspaces/${workspaceId}`);
        assert.equal(binding.status, 200);
        assert.notEqual(binding.body.revision, rebound.body.revision);
        assert.notEqual(
          binding.body.manifestHash,
          f.initial.manifestHash,
          "Real Workspace pointer must already commit before Agent finalization",
        );
      }
      await service.crash();
      await connection;
      await service.start();
      if (activation === "executor-first") await connect();
      assert.deepEqual((await service.api(`${probe}/canary`)).body, canary);
      if (activation === "agent-first") await connect();
    }
    let final: View | undefined;
    for (let i = 0; i < 900; i++) {
      await native.tick();
      final = await view();
      if (final.jobs[0]?.state === "completed" && f.ledger.get(job.jobId)?.committed) break;
      await pause(50);
    }
    const diagnostic = JSON.stringify({
      application: final,
      diagnostic: (await service.api(`${probe}/job-diagnostics?job=${job.jobId}`)).body,
      control: (await service.api(`/__test/dispatch-trace?job=${job.jobId}`)).body,
      native: {
        state: f.ledger.get(job.jobId)?.state,
        lease: f.ledger.get(job.jobId)?.assignment.identity.lease,
        result: f.ledger.get(job.jobId)?.result?.state,
        committed: !!f.ledger.get(job.jobId)?.committed,
        connected: native.connected,
      },
    });
    assert.equal(final?.jobs[0]?.state, "completed", diagnostic);
    assert.ok(f.ledger.get(job.jobId)?.committed, diagnostic);
    assert.ok((f.ledger.get(job.jobId)?.committed?.eventSeq ?? 0) > 0);
    assert.equal(f.ledger.get(job.jobId)?.assignment.identity.executionId, identity.executionId);
    assert.equal(f.ledger.get(job.jobId)?.assignment.identity.lease.fence, identity.lease.fence);
    assert.deepEqual(
      final.tasks.filter((task) => task.kind === "fortipi.dispatch").map((task) => task.id),
      children,
    );
    assert.equal((await readFile(marker, "utf8")).match(/start/g)?.length, 1);
    assert.deepEqual(
      await service.api(`/v1/conversations/${cid}/messages`, input, "POST", actor.token),
      sent,
    );
    const inspected = await service.api<{ entries: { kind: string }[] }>(
      `${probe}/inspect?cid=${cid}`,
    );
    assert.equal(inspected.body.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    console.log(
      JSON.stringify({
        canarySurvived: true,
        serviceSigkill: true,
        processStarts: 1,
        childIdsRetained: true,
        changedCommitAndNativeAck: true,
        candidateSafeOnly: true,
        killedAfterSeed: mode === "seed",
        killedAfterAtomicAttachment: mode === "attached",
        killedAfterSavedResult: mode === "result",
        killedAfterWorkspaceReceipt: mode === "receipt",
        killedWithActualAssignAckHeld: mode === "assign-ack",
        activation,
      }),
    );
  } finally {
    await writeFile(gate, "finish").catch(() => {});
    stop.abort();
    await connection;
    await runtime?.shutdown();
    await h?.close();
    await f.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}
