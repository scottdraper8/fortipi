import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  assignmentDigest,
  manifestDigest,
  operationDigest,
  validateAssignment,
} from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "./harness.ts";
import { workspaceTarget } from "./target.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const writer = { "x-test-dispatch-write": "1" };
function value<T>(result: D.Outcome<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.value;
}
async function json<T>(response: { json(): Promise<unknown> }): Promise<T> {
  return (await response.json()) as T;
}

async function setup(files = true, leaseMs = 30_000, reservationExtraMs = 0) {
  const server = harness();
  await server.listen();
  const rpc = async <T>(body: unknown, headers: Record<string, string> = {}) =>
    json<D.Outcome<T>>(
      await server.fetch("/rpc", { method: "POST", headers, body: JSON.stringify(body) }),
    );
  let binding = value(await json<D.Outcome<D.WorkspaceBinding>>(await server.fetch("/seed")));
  const bytes = Uint8Array.from({ length: 1_100_013 }, (_, i) => i % 251);
  if (files) {
    const lease = value(
      await rpc<D.Lease>({
        kind: "acquire",
        input: await workspaceTarget("source", binding.revision),
      }),
    );
    const manifest: D.Manifest = {
      version: 1,
      entries: [
        { type: "file", path: "canary", mode: 420, size: bytes.length, sha256: sha(bytes) },
        { type: "file", path: "empty", mode: 420, size: 0, sha256: sha(new Uint8Array()) },
      ],
    };
    const hash = await manifestDigest(manifest);
    const begun = value(
      await rpc<{ status: 201; body: D.UploadStatus }>({
        kind: "begin",
        input: {
          operationId: "beginUpload",
          path: { workspaceId: "workspace" },
          query: {},
          body: {
            requestId: "source-upload",
            commitId: "source-commit",
            operationId: lease.operationId,
            baseRevision: binding.revision,
            lease,
            manifest,
            manifestHash: hash,
            mutations: manifest.entries
              .filter((e) => e.type === "file")
              .map((e) => ({
                kind: "put",
                path: e.path,
                mode: e.mode,
                size: e.size,
                sha256: e.sha256,
              })),
          },
        },
      }),
    );
    for (let offset = 0, index = 0; offset < bytes.length; offset += 262144, index++) {
      const chunk = bytes.slice(offset, offset + 262144);
      value(
        await rpc({
          kind: "chunk",
          input: {
            operationId: "putUploadChunk",
            path: {
              workspaceId: "workspace",
              uploadId: begun.body.uploadId,
              sha256: sha(bytes),
              chunkIndex: index,
            },
            query: { length: chunk.length, sha256: sha(chunk) },
          },
          bytes: [...chunk],
        }),
      );
    }
    const sealed = value(
      await rpc<{ status: 200; body: D.UploadValidation }>({
        kind: "validate",
        input: {
          operationId: "validateUpload",
          path: { workspaceId: "workspace", uploadId: begun.body.uploadId },
          query: {},
        },
      }),
    );
    const receipt = value(
      await rpc<{ status: 200; body: D.CommitReceipt }>({
        kind: "commit",
        input: {
          operationId: "commitUpload",
          path: { workspaceId: "workspace", uploadId: begun.body.uploadId },
          query: {},
          body: {
            requestId: "source-commit",
            stageId: sealed.body.stageId,
            uploadId: begun.body.uploadId,
            commitId: "source-commit",
            operationId: lease.operationId,
            workspaceId: "workspace",
            lease,
            baseRevision: binding.revision,
            manifestHash: hash,
          },
        },
      }),
    ).body;
    value(await rpc({ kind: "release", input: { requestId: "release-source", lease } }));
    binding = { ...binding, revision: receipt.revision, manifestHash: receipt.manifestHash };
  }
  const operationContext: D.OperationContext = {
    deploymentId: "test-deployment",
    agentId: "agent",
    conversationId: "conversation",
    policyVersion: 1,
  };
  const operation: D.OperationDigestInput = {
    ...operationContext,
    tool: "javascript",
    arguments: { source: "p".repeat(70_000) },
    workspaceId: "workspace",
    baseRevision: binding.revision,
    target: { kind: "executor", executorId: "executor", generation: 1 },
    grantVersion: 1,
    deadline: Date.now() + 30_000 - reservationExtraMs,
  };
  const digest = await operationDigest(operation);
  const target: D.TargetRequest = {
    ownerKind: "job",
    operationId: "native-op",
    operationDigest: digest,
    workspaceId: "workspace",
    bindingVersion: 1,
    target: operation.target,
    actions: ["workspace.write"],
    agentId: "agent",
    conversationId: "conversation",
    jobId: "native-job",
    executionId: "native-eid",
    deadline: operation.deadline + reservationExtraMs,
    expiresAt: Math.min(operation.deadline + reservationExtraMs, Date.now() + leaseMs),
  };
  const reservation = value(await rpc<D.TargetReservation>({ kind: "reservation", input: target }));
  const lease = value(await rpc<D.Lease>({ kind: "acquire", input: target }));
  const assignment: D.Assignment = {
    workspaceId: "workspace",
    bindingVersion: 1,
    reservationId: reservation.reservationId,
    operationContext,
    tool: operation.tool,
    arguments: operation.arguments,
    identity: {
      jobId: "native-job",
      executionId: "native-eid",
      operationDigest: digest,
      assignmentDigest: await assignmentDigest({
        operation,
        executionId: "native-eid",
        reservationId: reservation.reservationId,
        leaseId: lease.leaseId,
        fence: lease.fence,
        executorGeneration: lease.executorGeneration,
      }),
      target: operation.target,
      lease,
      baseRevision: binding.revision,
      deadline: operation.deadline,
    },
  };
  const access: D.ExecutorWorkspaceAccess = { assignment, lease };
  const request = (
    input: unknown = access,
    query = "",
    headers: Record<string, string> = writer,
    method = "POST",
  ) =>
    server.fetch(`/job-snapshot${query}`, {
      method,
      headers,
      ...(method !== "GET" ? { body: JSON.stringify(input) } : {}),
    });
  return { server, rpc, binding, bytes, access, request, reservation };
}

test("snapshot accepts a canonical shorter assignment deadline but never exceeds its actual reservation", async () => {
  for (const extra of [10_000, -10_000]) {
    const h = await setup(true, 30_000, extra);
    try {
      await validateAssignment(h.access.assignment);
      assert.equal(h.reservation.operationDigest, h.access.assignment.identity.operationDigest);
      assert.equal(h.reservation.deadline - h.access.assignment.identity.deadline, extra);
      const original = JSON.stringify({ access: h.access, reservation: h.reservation });
      const storage = await h.server
        .getWorker()
        .getDurableObjectStorage("WORKSPACES", { name: "workspace" });
      const retained = () =>
        storage.exec(
          "SELECT key,value FROM fp_ws_record WHERE key IN (?,?,?) ORDER BY key",
          "authority",
          `reservation:${h.access.lease.leaseId}`,
          `lease-acquire:${h.reservation.reservationId}`,
        );
      const before = await retained();
      const response = await h.request();
      if (extra > 0) {
        assert.equal(response.status, 200, "Valid shorter assignment deadline was rejected");
        const result = await json<D.ManifestResponse>(response);
        assert.equal(result.manifestHash, h.binding.manifestHash);
        const blob = await h.request(h.access, `?sha256=${sha(h.bytes)}`);
        assert.equal(blob.status, 200);
        assert.equal(blob.headers.get("X-Content-SHA256"), sha(h.bytes));
        assert.equal(sha(new Uint8Array(await blob.arrayBuffer())), sha(h.bytes));
      } else
        assert.equal(response.status, 409, "Assignment exceeded its retained reservation deadline");
      assert.equal(
        JSON.stringify({ access: h.access, reservation: h.reservation }),
        original,
        "Deadline access rewrote original authority",
      );
      assert.deepEqual(
        await retained(),
        before,
        "Snapshot access changed retained reservation/acquisition/lease authority",
      );
    } finally {
      await h.server.close();
    }
  }
});

test("private native job snapshot returns its actual leased Computer base without public read", {
  timeout: 60_000,
}, async () => {
  const h = await setup();
  try {
    assert.ok(JSON.stringify(h.access).length > 65_536);
    const manifest = await h.request();
    assert.equal(manifest.status, 200, "Registered dispatch writer could not read leased base");
    assert.equal(manifest.headers.get("Cache-Control"), "no-store");
    const result = await json<D.ManifestResponse>(manifest);
    assert.equal(result.manifestHash, h.binding.manifestHash);
    assert.equal(await manifestDigest(result.manifest), result.manifestHash);
    for (const bytes of [h.bytes, new Uint8Array()]) {
      const response = await h.request(h.access, `?sha256=${sha(bytes)}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Length"), String(bytes.length));
      assert.equal(response.headers.get("X-Content-SHA256"), sha(bytes));
      assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
      assert.equal(sha(new Uint8Array(await response.arrayBuffer())), sha(bytes));
    }
    assert.equal(
      (
        await h.server.fetch(`/read?revision=${h.binding.revision}&path=canary`, {
          headers: writer,
        })
      ).status,
      403,
    );
    const publicManifest = await h.rpc(
      {
        kind: "manifest",
        input: {
          operationId: "getWorkspaceManifest",
          path: { workspaceId: "workspace" },
          query: { revision: h.binding.revision },
        },
      },
      writer,
    );
    assert.equal(publicManifest.ok, false);
    for (const headers of [
      { "x-test-write-only": "1" },
      { ...writer, "x-test-other-tool": "1" },
      { ...writer, "x-test-other-agent": "1" },
      { ...writer, "x-test-other-conversation": "1" },
      { ...writer, "x-test-other-target": "1" },
      { ...writer, "x-test-split-actions": "1" },
      { ...writer, "x-test-unregistered": "1" },
      { ...writer, "x-test-recovery": "1" },
      { ...writer, "x-test-expired": "1" },
      { ...writer, "x-test-no-context": "1" },
    ])
      assert.ok(
        [401, 403].includes((await h.request(h.access, "", headers)).status),
        "Incomplete owner grant exposed a leased snapshot",
      );
    for (const patch of [{ bindingVersion: 2 }, { reservationId: "other" }])
      assert.ok(
        (await h.request({ ...h.access, assignment: { ...h.access.assignment, ...patch } }))
          .status >= 400,
      );
    for (const identity of [
      { ...h.access.assignment.identity, executionId: "other" },
      { ...h.access.assignment.identity, baseRevision: "other" },
      { ...h.access.assignment.identity, assignmentDigest: "0".repeat(64) },
      { ...h.access.assignment.identity, operationDigest: "0".repeat(64) },
    ])
      assert.ok(
        (await h.request({ ...h.access, assignment: { ...h.access.assignment, identity } }))
          .status >= 400,
      );
    assert.ok(
      (await h.request({ ...h.access, lease: { ...h.access.lease, fence: "999" } })).status >= 400,
    );
    assert.ok(
      (await h.request({ ...h.access, lease: { ...h.access.lease, expiresAt: 0 } })).status >= 400,
    );
    for (const query of [
      "?unknown=1",
      "?sha256=bad",
      `?sha256=${sha(h.bytes)}&sha256=${sha(h.bytes)}`,
    ])
      assert.equal((await h.request(h.access, query)).status, 400);
    assert.equal((await h.request({ ...h.access, extra: true })).status, 400);
    assert.equal((await h.request(h.access, "", writer, "GET")).status, 400);
    assert.equal(
      (await h.request(h.access, `?sha256=${sha(h.bytes)}`, { ...writer, Range: "bytes=0-3" }))
        .status,
      400,
    );
    assert.equal(
      (
        await h.request({
          assignment: { ...h.access.assignment, arguments: { source: "x".repeat(1_048_576) } },
          lease: h.access.lease,
        })
      ).status,
      413,
    );
    const staged = new TextEncoder().encode("unpublished");
    const manifest2: D.Manifest = {
      version: 1,
      entries: [
        { type: "file", path: "canary", mode: 420, size: staged.length, sha256: sha(staged) },
      ],
    };
    const opened = value(
      await h.rpc<{ status: 201; body: D.UploadStatus }>({
        kind: "begin",
        input: {
          operationId: "beginUpload",
          path: { workspaceId: "workspace" },
          query: {},
          body: {
            requestId: "staged-only",
            commitId: "staged-only",
            operationId: h.access.lease.operationId,
            baseRevision: h.binding.revision,
            lease: h.access.lease,
            manifest: manifest2,
            manifestHash: await manifestDigest(manifest2),
            mutations: [
              { kind: "put", path: "canary", mode: 420, size: staged.length, sha256: sha(staged) },
              { kind: "delete", path: "empty" },
            ],
          },
        },
      }),
    );
    value(
      await h.rpc({
        kind: "chunk",
        input: {
          operationId: "putUploadChunk",
          path: {
            workspaceId: "workspace",
            uploadId: opened.body.uploadId,
            sha256: sha(staged),
            chunkIndex: 0,
          },
          query: { length: staged.length, sha256: sha(staged) },
        },
        bytes: [...staged],
      }),
    );
    value(
      await h.rpc({
        kind: "validate",
        input: {
          operationId: "validateUpload",
          path: { workspaceId: "workspace", uploadId: opened.body.uploadId },
          query: {},
        },
      }),
    );
    assert.equal(
      (await h.request(h.access, `?sha256=${sha(staged)}`)).status,
      404,
      "Staged hash escaped assigned base membership",
    );
  } finally {
    await h.server.close();
  }
});

test("snapshot metadata has no Computer effects and rechecks current authority after awaiting", async () => {
  const h = await setup(false);
  try {
    const storage = await h.server
      .getWorker()
      .getDurableObjectStorage("WORKSPACES", { name: "workspace" });
    const before = await storage.exec("SELECT key,value FROM fp_ws_record ORDER BY key");
    const response = await h.request();
    assert.equal(response.status, 200);
    assert.deepEqual((await json<D.ManifestResponse>(response)).manifest, {
      version: 1,
      entries: [],
    });
    assert.deepEqual(await storage.exec("SELECT key,value FROM fp_ws_record ORDER BY key"), before);
    assert.equal(
      (await h.request(h.access, "", { ...writer, "x-test-snapshot-queued": "1" })).status,
      403,
      "Queued revoked context exposed snapshot metadata",
    );
  } finally {
    await h.server.close();
  }
});

test("snapshot streams reject revocation or rebind after blocked reads and propagate cancellation", {
  timeout: 90_000,
}, async () => {
  for (const mode of ["revoke", "executor", "rebind", "lease", "expiry", "cancel"]) {
    const h = await setup(true, mode === "expiry" ? 1000 : 30_000);
    try {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let pending: Promise<{ accepted: number; rejected: boolean }>;
      const headers = { ...writer, "x-test-request-id": "snapshot-block" };
      if (mode === "cancel") {
        const response = await h.request(h.access, `?sha256=${sha(h.bytes)}`, headers);
        assert.equal(response.status, 200);
        assert.ok(response.body);
        reader = response.body.getReader();
        pending = reader.read().then(
          (next) => ({ accepted: next.value?.length ?? 0, rejected: false }),
          () => ({ accepted: 0, rejected: true }),
        );
      } else
        pending = h
          .request(h.access, `?sha256=${sha(h.bytes)}`, {
            ...headers,
            "x-test-snapshot-direct": "1",
          })
          .then((response) => json<{ accepted: number; rejected: boolean }>(response))
          .catch(() => ({ accepted: -1, rejected: true }));
      const deadline = Date.now() + 10_000;
      while (
        Date.now() < deadline &&
        (await (await h.server.fetch("/snapshot-barrier")).text()) !== "ready"
      )
        await delay(10);
      assert.equal(await (await h.server.fetch("/snapshot-barrier")).text(), "ready");
      if (mode === "revoke")
        value(
          await h.rpc({
            kind: "invalidate",
            input: {
              revocationId: "snapshot-stream-floor",
              subject: { kind: "credential", credentialId: "credential", minimumGeneration: 2 },
            },
          }),
        );
      if (mode === "executor")
        value(
          await h.rpc({
            kind: "invalidate",
            input: {
              revocationId: "snapshot-executor-floor",
              subject: { kind: "executor", executorId: "executor", minimumGeneration: 2 },
            },
          }),
        );
      if (mode === "expiry") await delay(1200);
      if (mode === "rebind") {
        const manifest = value(
          await h.rpc<{ status: 200; body: D.ManifestResponse }>({
            kind: "manifest",
            input: {
              operationId: "getWorkspaceManifest",
              path: { workspaceId: "workspace" },
              query: { revision: h.binding.revision },
            },
          }),
        ).body.manifest;
        value(
          await h.rpc(
            {
              kind: "binding",
              input: {
                requestId: "snapshot-rebind",
                binding: {
                  workspaceId: "workspace",
                  bindingVersion: 2,
                  config: { kind: "computer" },
                },
                expectedVersion: 1,
                import: {
                  revision: h.binding.revision,
                  manifest,
                  acknowledgeExternalEffects: true,
                },
              },
            },
            { "x-test-bootstrap": "1" },
          ),
        );
      }
      if (mode === "lease")
        value(
          await h.rpc({
            kind: "release",
            input: { requestId: "snapshot-end-lease", lease: h.access.lease },
          }),
        );
      if (mode === "cancel") await reader?.cancel();
      await h.server.fetch("/snapshot-release");
      const observed = await pending;
      assert.equal(
        observed.accepted,
        0,
        "Changed snapshot authority released bytes after a blocked read",
      );
      if (mode !== "cancel") assert.equal(observed.rejected, true);
      else {
        const stopped = Date.now() + 2000;
        while (
          Date.now() < stopped &&
          !(await json<boolean>(await h.server.fetch("/snapshot-cancelled")))
        )
          await delay(10);
        assert.equal(
          await json<boolean>(await h.server.fetch("/snapshot-cancelled")),
          true,
          "Body cancellation did not reach actual Computer reader",
        );
      }
      await reader?.cancel().catch(() => {});
    } finally {
      await h.server.close();
    }
  }
});
