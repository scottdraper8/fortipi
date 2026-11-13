import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ExecutorRuntime,
  HttpTransport,
  SessionTransport,
} from "../../../../packages/fortipi-executor/dist/index.js";
import {
  fixture,
  nodeCommand,
} from "../../../../packages/fortipi-executor/test/fixtures/daemon.ts";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import type * as D from "../../src/boundary/dto.js";
import { bootstrap } from "../agent/harness.ts";
import { nativeService } from "../execution/native-service.ts";
import { bytes } from "./fixture-state.ts";
import { poll } from "./runtime.ts";
import { readWorkspace, stageWorkspace } from "./workspace-portability.ts";

/** Same-host device replacement: real separate native roots/SQLite ledgers and
 * real Computer revisions. A's entire disk tree is removed before B starts. */
export async function deviceReplacement() {
  const n = await nativeService({
    computer: true,
    approve: false,
    localConsent: false,
    reconciliation: true,
  });
  const b = await fixture(),
    stopB = new AbortController();
  let runtimeB: ExecutorRuntime | undefined, connectionB: Promise<void> | undefined;
  let removedA = false,
    stoppedA = false;
  const { url } = await n.h.server.listen(),
    endpoint = new URL(url).origin;
  const roles = new RoleContext(endpoint, bootstrap);
  try {
    const initial = await n.h.api<D.Approval>(`/v1/approvals/${n.job.approvalId}`);
    assert.equal(initial.status, 200);
    assert.equal(
      (
        await n.h.api(`/v1/approvals/${n.job.approvalId}/decisions`, {
          requestId: randomUUID(),
          expectedVersion: initial.body.version,
          operationDigest: initial.body.operation.operationDigest,
          decision: "reject",
        })
      ).status,
      200,
    );
    await poll(n.state, (state) => state.jobs[0]?.state === "cancelled");
    await n.probe.releaseCompletion();
    await poll(
      async () => (await n.h.api<D.Task>(`/v1/tasks/${n.sent.body.taskId}`)).body,
      (task) => ["completed", "failed", "cancelled"].includes(task.status.state),
    );
    const writer = await roles.issue({
      requestId: randomUUID(),
      role: "client",
      expiresAt: Date.now() + 600000,
      grants: [
        {
          grantId: randomUUID(),
          version: 1,
          resources: {
            agentIds: [],
            conversationIds: [],
            workspaceIds: [n.workspaceId],
            executorIds: [],
            backendIds: [n.workspaceId],
            tools: [],
            actions: ["workspace.read", "workspace.write"],
          },
        },
      ],
    });
    let binding = (await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`)).body;
    const port = { endpoint, api: n.h.api };
    const stage = await stageWorkspace(port, binding, writer.token, bytes),
      base = await stage.commit();
    assert.equal(base.status, 200);
    await stage.release();
    binding = { ...binding, revision: base.body.revision, manifestHash: base.body.manifestHash };
    const r0 = binding;
    const bId = randomUUID(),
      empty: D.ResourceScope = {
        agentIds: [],
        conversationIds: [],
        workspaceIds: [],
        executorIds: [bId],
        backendIds: [],
        tools: [],
        actions: ["tickets.mint", "executors.register"],
      };
    const seed = await roles.issue({
      requestId: randomUUID(),
      role: "executor",
      executorId: bId,
      expiresAt: Date.now() + 600000,
      grants: [{ grantId: randomUUID(), version: 1, resources: empty }],
    });
    assert.equal(
      (
        await n.h.api(
          "/v1/connections/tickets",
          {
            requestId: randomUUID(),
            audience: "executor-session",
            resources: empty,
            originMode: { kind: "native" },
            executor: { executorId: bId, generation: 1 },
          },
          "POST",
          seed.token,
        )
      ).status,
      201,
    );
    const resources: D.ResourceScope = {
      agentIds: [n.agent.agentId],
      conversationIds: [n.conversation.conversationId],
      workspaceIds: [n.workspaceId],
      executorIds: [bId],
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
    const bRole = await roles.issue({
      requestId: randomUUID(),
      role: "executor",
      executorId: bId,
      expiresAt: Date.now() + 600000,
      grants: [{ grantId: randomUUID(), version: 1, resources }],
    });
    const actor = await roles.issue({
      requestId: randomUUID(),
      role: "client",
      expiresAt: Date.now() + 600000,
      grants: [
        {
          grantId: randomUUID(),
          version: 1,
          resources: {
            ...resources,
            executorIds: [n.f.profile.executorId, bId],
            actions: [
              "messages.submit",
              "conversations.read",
              "events.read",
              "tasks.read",
              "jobs.read",
              "jobs.dispatch",
              "workspace.read",
              "workspace.write",
              "approvals.read",
              "approvals.decide",
            ],
          },
        },
      ],
    });
    assert.notEqual(b.root.key, n.f.root.key);
    const aDatabase = await stat(n.f.ledger.path),
      bDatabase = await stat(b.ledger.path);
    assert.ok(
      aDatabase.dev !== bDatabase.dev || aDatabase.ino !== bDatabase.ino,
      "Native devices must have different actual SQLite files",
    );
    assert.deepEqual(await readdir(b.rootPath), []);
    const run = async (
      runtime: ExecutorRuntime,
      host: Awaited<ReturnType<typeof fixture>>,
      before: string,
      after: string,
    ) => {
      const previous = new Set((await n.state()).jobs.map((job) => job.jobId));
      const marker = resolve(host.path, "device-starts"),
        nonce = randomUUID();
      const command = nodeCommand(
        resolve(import.meta.dirname, "../../../../tests/clients/fixtures/process-marker.ts"),
        marker,
        nonce,
        "edit",
        before,
        after,
      );
      await n.probe.queueTool(
        JSON.stringify({
          tool: "shell",
          arguments: { command },
          workspaceId: n.workspaceId,
          baseRevision: binding.revision,
          target: {
            kind: "executor",
            executorId: runtime.profile.executorId,
            generation: runtime.profile.executorGeneration,
          },
          capabilities: ["shell"],
        }),
      );
      const input: D.MessageSubmit = {
        clientRequestId: randomUUID(),
        content: `seed1010-${after}`,
        busyBehavior: "followUp",
      };
      const admitted = await n.h.api<D.AdmissionReceipt>(
        `/v1/conversations/${n.conversation.conversationId}/messages`,
        input,
        "POST",
        actor.token,
      );
      assert.equal(admitted.status, 202);
      const waiting = await poll(n.state, (state) =>
        state.jobs.some((job) => !previous.has(job.jobId) && !!job.approvalId),
      );
      const pending = waiting.jobs.find((job) => !previous.has(job.jobId))!;
      const approval = await n.h.api<D.Approval>(
        `/v1/approvals/${pending.approvalId}`,
        undefined,
        "GET",
        actor.token,
      );
      assert.equal(approval.status, 200);
      assert.equal(
        (
          await n.h.api(
            `/v1/approvals/${pending.approvalId}/decisions`,
            {
              requestId: randomUUID(),
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
      const local = await poll(
        async () => runtime.approvals.list().find((entry) => entry.jobId === pending.jobId),
        Boolean,
      );
      assert.ok(local);
      assert.equal(await readFile(marker, "utf8").catch(() => ""), "");
      runtime.approvals.decide(pending.jobId, local.digest, "allow");
      await runtime.tick();
      const job = await poll(
        async () =>
          (await n.h.api<D.Job>(`/v1/jobs/${pending.jobId}`, undefined, "GET", actor.token)).body,
        (job) =>
          [
            "completed",
            "failed",
            "requires_reconciliation",
            "workspace_conflict",
            "interrupted",
          ].includes(job.state),
      );
      assert.equal(job.state, "completed");
      if (job.state !== "completed") assert.fail("Actual Computer commit required");
      assert.equal(job.evidence.kind, "committed");
      await poll(
        async () => host.ledger.get(job.jobId),
        (row) => !!row?.committed,
      );
      assert.equal(await readFile(marker, "utf8"), `${nonce}\n`);
      binding = (await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`)).body;
      await readWorkspace(port, binding, writer.token, {
        ...bytes,
        "notes.txt": Buffer.from(`${after}\n`),
      });
      await poll(
        async () =>
          (
            await n.h.api<D.Task>(
              `/v1/tasks/${admitted.body.taskId}`,
              undefined,
              "GET",
              actor.token,
            )
          ).body,
        (task) => task.status.state === "completed",
      );
      return {
        jobId: job.jobId,
        taskId: admitted.body.taskId,
        revision: binding.revision,
        starts: 1,
      };
    };
    const a = await run(n.runtime, n.f, "old-v1", "R1-on-A"),
      r1 = binding;
    const history = await n.h.api<D.ReplayPage>(
      `/v1/conversations/${n.conversation.conversationId}/events?after=0`,
      undefined,
      "GET",
      actor.token,
    );
    assert.equal(history.status, 200);
    n.runtime.session?.socket?.close();
    await poll(
      async () => (await n.h.api<D.ExecutorPage>("/v1/executors")).body,
      (page) =>
        page.items.some(
          (executor) =>
            executor.executorId === n.f.profile.executorId && executor.state === "offline",
        ),
    );
    await n.runtime.shutdown();
    stoppedA = true;
    await n.f.cleanup();
    removedA = true;
    await assert.rejects(stat(n.f.path), { code: "ENOENT" });
    const revokeRequestId = randomUUID();
    const revoke = () =>
      roles.call({
        operationId: "revokeExecutor",
        path: { id: n.f.profile.executorId },
        query: {},
        body: { requestId: revokeRequestId, expectedGeneration: n.f.profile.executorGeneration },
      });
    const retired = await poll(revoke, (receipt) => receipt.state === "complete");
    assert.equal(retired.state, "complete");
    const stale = await n.h.api(
      "/v1/connections/tickets",
      {
        requestId: randomUUID(),
        audience: "executor-session",
        resources: n.f.profile.resources,
        originMode: { kind: "native" },
        executor: {
          executorId: n.f.profile.executorId,
          generation: n.f.profile.executorGeneration,
        },
      },
      "POST",
      n.f.profile.token,
    );
    assert.equal(
      stale.status,
      409,
      "Retired A's actual old credential/generation cannot open a new execution session",
    );
    Object.assign(b.profile, {
      origin: endpoint,
      deploymentId: n.f.profile.deploymentId,
      executorId: bId,
      executorGeneration: 1,
      credential: bRole.credential,
      token: bRole.token,
      resources,
    });
    b.profile.bindings = [
      {
        rootBindingId: "root",
        workspaceId: n.workspaceId,
        bindingVersion: binding.bindingVersion,
        path: b.rootPath,
        revision: binding.revision,
        manifestHash: binding.manifestHash,
        providerKind: "computer",
      },
    ];
    b.profile.policy.rules = [];
    const requests: { path: string; status: number }[] = [];
    runtimeB = new ExecutorRuntime({
      profile: b.profile,
      ledger: b.ledger,
      directory: b.directory,
      roots: new Map([["root", b.root]]),
      http: new HttpTransport(
        b.profile,
        async (input, init) => {
          const response = await fetch(input, init);
          requests.push({
            path: new URL(input instanceof Request ? input.url : String(input)).pathname,
            status: response.status,
          });
          return response;
        },
        true,
      ),
    });
    await runtimeB.initialize();
    const session = new SessionTransport(runtimeB.http, runtimeB);
    runtimeB.session = session;
    connectionB = session
      .connect(stopB.signal, {
        type: "executor.register",
        requestId: randomUUID(),
        payload: {
          executorId: bId,
          generation: 1,
          protocolVersion: "1.0",
          schemaVersion: "1.0.0",
          platform: process.platform as "darwin" | "linux" | "win32",
          caseBehavior: b.root.identity.caseBehavior,
          confinement: "host",
          capabilities: ["shell", "local-workspace", "snapshots"],
          rootBindingIds: ["root"],
          transferLimits: runtimeB.http.transferLimits(),
        },
      })
      .catch(() => {});
    await poll(async () => runtimeB!.connected, Boolean);
    const replacement = await run(runtimeB, b, "R1-on-A", "R2-on-B");
    assert.notEqual(replacement.jobId, a.jobId);
    assert.notEqual(replacement.revision, a.revision);
    assert.ok(
      requests.some((request) => request.path.endsWith("/manifest") && request.status === 200),
    );
    assert.ok(
      requests.some((request) => request.path.includes("/blobs/") && request.status === 200),
    );
    await readWorkspace(port, r0, writer.token, bytes);
    await readWorkspace(port, r1, writer.token, {
      ...bytes,
      "notes.txt": Buffer.from("R1-on-A\n"),
    });
    const after = await n.h.api<D.ReplayPage>(
      `/v1/conversations/${n.conversation.conversationId}/events?after=0`,
      undefined,
      "GET",
      actor.token,
    );
    assert.deepEqual(
      after.body.events.slice(0, history.body.events.length),
      history.body.events,
      "Device replacement preserves original canonical conversation envelopes",
    );
    return {
      actualComputerAndNative: true,
      platform: process.platform,
      separateRootsAndSqliteFiles: true,
      aDiskEntirelyRemovedBeforeBStart: removedA,
      publicExecutorRetirementComplete: true,
      staleASessionStatus: stale.status,
      devices: [a, replacement],
      currentRevision: binding.revision,
      originalRevisionReadable: true,
      aRevisionReadable: true,
      actualBFetchedManifestAndBlobs: true,
      originalEventPrefixSha256: createHash("sha256")
        .update(JSON.stringify(history.body.events))
        .digest("hex"),
      limitations: [
        "Two real native roots on one host with source runtime APIs; no separate-live-host, installed-daemon, paid JS/Linux or platform eviction claim",
      ],
    };
  } finally {
    stopB.abort();
    await connectionB;
    await runtimeB?.shutdown();
    if (!stoppedA) {
      n.runtime.session?.socket?.close();
      await n.runtime.shutdown();
    }
    const cleanup = await roles.cleanup();
    await n.h.close();
    if (!removedA) await n.f.cleanup();
    await b.cleanup();
    assert.ok(
      cleanup.every((role) => role.state === "complete"),
      "Replacement ephemeral role revocation is pending/unknown",
    );
  }
}
