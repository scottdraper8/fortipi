import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { manifestDigest } from "../../../../packages/fortipi-contract/dist/index.js";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import type * as D from "../../src/boundary/dto.js";
import { bytes as initialBytes } from "./fixture-state.ts";
import { poll, type Runtime, start } from "./runtime.ts";

const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export interface WorkspacePort {
  endpoint: string;
  api: Runtime["api"];
}
export async function stageWorkspace(
  runtime: WorkspacePort,
  binding: D.WorkspaceBinding,
  token: string,
  files: Record<string, Uint8Array>,
  maximumChunks = Number.POSITIVE_INFINITY,
) {
  const manifest: D.Manifest = {
    version: 1,
    entries: Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, data]) => ({
        path,
        type: "file",
        mode: 420,
        size: data.byteLength,
        sha256: digest(data),
      })),
  };
  const manifestHash = await manifestDigest(manifest),
    operationId = randomUUID(),
    commitId = randomUUID();
  const base = `/v1/workspaces/${binding.workspaceId}`;
  const acquired = await runtime.api<D.WorkspaceOperationLease>(
    `${base}/leases`,
    {
      requestId: randomUUID(),
      operationId,
      bindingVersion: binding.bindingVersion,
      baseRevision: binding.revision,
      deadline: Date.now() + 120000,
    },
    "POST",
    token,
  );
  assert.equal(acquired.status, 201, "Actual non-job lease must be granted");
  const lease = acquired.body;
  const opened = await runtime.api<D.UploadStatus>(
    `${base}/uploads`,
    {
      requestId: randomUUID(),
      baseRevision: binding.revision,
      lease,
      operationId,
      commitId,
      manifest,
      manifestHash,
      blobs: [...new Map(Object.values(files).map((data) => [digest(data), data])).values()].map(
        (data) => ({
          sha256: digest(data),
          chunks: {
            chunkBytes: 262144,
            chunkHashes: Array.from({ length: Math.ceil(data.byteLength / 262144) }, (_, i) =>
              digest(data.subarray(i * 262144, (i + 1) * 262144)),
            ),
          },
        }),
      ),
      mutations: manifest.entries.map((entry) => {
        assert.equal(entry.type, "file");
        if (entry.type !== "file") throw new Error("Fixture has no directory mutations");
        return { kind: "put", path: entry.path, mode: 420, size: entry.size, sha256: entry.sha256 };
      }),
    },
    "POST",
    token,
  );
  assert.equal(opened.status, 201, "Actual public staging must be allocated");
  const upload = `${base}/uploads/${opened.body.uploadId}`;
  let chunks = 0,
    complete = true;
  for (const data of Object.values(files)) {
    const hash = digest(data);
    for (let at = 0, index = 0; at < data.byteLength; at += 262144, index++) {
      if (chunks >= maximumChunks) {
        complete = false;
        break;
      }
      const part = data.subarray(at, Math.min(data.byteLength, at + 262144));
      const response = await fetch(
        `${runtime.endpoint}${upload}/blobs/${hash}/chunks/${index}?length=${part.byteLength}&sha256=${digest(part)}`,
        {
          method: "PUT",
          redirect: "error",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
          body: new Uint8Array(part),
          signal: AbortSignal.timeout(20000),
        },
      );
      assert.equal(response.status, 204, "Actual byte upload must acknowledge the exact chunk");
      chunks++;
    }
  }
  let validated: D.UploadValidation | undefined;
  if (complete) {
    const result = await poll(
      async () =>
        runtime.api<D.UploadValidation | D.ErrorBody>(
          `${upload}/validate`,
          undefined,
          "POST",
          token,
        ),
      (result) => result.status !== 503,
    );
    assert.equal(result.status, 200);
    assert.ok("stageId" in result.body);
    validated = result.body;
  }
  const requestId = randomUUID();
  return {
    lease,
    manifest,
    manifestHash,
    uploadId: opened.body.uploadId,
    commitId,
    chunks,
    complete,
    commit: (changes: Partial<D.UploadCommit> = {}) => {
      assert.ok(validated, "An incomplete stage can never be treated as a prepared result");
      return runtime.api<D.CommitReceipt>(
        `${upload}/commit`,
        {
          requestId,
          stageId: validated.stageId,
          commitId,
          uploadId: opened.body.uploadId,
          operationId,
          workspaceId: binding.workspaceId,
          lease,
          manifestHash,
          baseRevision: binding.revision,
          ...changes,
        },
        "POST",
        token,
      );
    },
    abort: () => runtime.api(`${upload}/abort`, undefined, "POST", token),
    release: () =>
      runtime.api(
        `${base}/leases/${lease.leaseId}/release`,
        { requestId: randomUUID(), lease, reason: "completed" },
        "POST",
        token,
      ),
  };
}
export async function readWorkspace(
  runtime: WorkspacePort,
  binding: D.WorkspaceBinding,
  token: string,
  files: Record<string, Uint8Array>,
) {
  for (const [path, expected] of Object.entries(files)) {
    const query = new URLSearchParams({ revision: binding.revision, path });
    const response = await fetch(
      `${runtime.endpoint}/v1/workspaces/${binding.workspaceId}/read?${query}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    assert.equal(response.status, 200);
    const actual = new Uint8Array(await response.arrayBuffer());
    assert.equal(actual.byteLength, expected.byteLength);
    assert.equal(
      digest(actual),
      digest(expected),
      "Independent original file hash must survive publication/rejection",
    );
  }
}
export async function workspaceAtomicBytes() {
  const runtime = await start(),
    roles = new RoleContext(runtime.endpoint, runtime.admin);
  try {
    const created = await roles.call({
      operationId: "createWorkspace",
      path: {},
      query: {},
      body: { requestId: randomUUID(), config: { kind: "computer" } },
    });
    const client = await roles.issue({
      requestId: randomUUID(),
      role: "client",
      grants: [
        {
          grantId: randomUUID(),
          version: 1,
          resources: {
            agentIds: [],
            conversationIds: [],
            workspaceIds: [created.workspaceId],
            executorIds: [],
            backendIds: [],
            tools: [],
            actions: ["workspace.read", "workspace.write"],
          },
        },
      ],
    });
    const r0 = await stageWorkspace(runtime, created, client.token, initialBytes);
    const committed = await r0.commit();
    assert.equal(committed.status, 200);
    assert.deepEqual(
      await r0.commit(),
      committed,
      "Commit acknowledgment retry must retain exactly the same receipt",
    );
    const binding = {
      ...created,
      revision: committed.body.revision,
      manifestHash: committed.body.manifestHash,
    };
    await r0.release();
    await readWorkspace(runtime, binding, client.token, initialBytes);
    await runtime.stopAbruptly();
    await runtime.reopenSameStorage();
    await readWorkspace(runtime, binding, client.token, initialBytes);
    const interrupted = await stageWorkspace(
      runtime,
      binding,
      client.token,
      {
        "multi.bin": initialBytes["multi.bin"].map((value) => value ^ 0x5a),
        "notes.txt": initialBytes["notes.txt"],
        "binary.bin": initialBytes["binary.bin"],
      },
      1,
    );
    assert.equal(interrupted.complete, false);
    assert.equal(interrupted.chunks, 1);
    const incomplete = await runtime.api<D.ErrorBody>(
      `/v1/workspaces/${binding.workspaceId}/uploads/${interrupted.uploadId}/validate`,
      undefined,
      "POST",
      client.token,
    );
    assert.ok(
      incomplete.status >= 400 && incomplete.status < 500,
      "Incomplete multi-chunk bytes must not validate",
    );
    await interrupted.abort();
    await interrupted.release();
    await readWorkspace(runtime, binding, client.token, initialBytes);
    const nextBytes = { ...initialBytes, "notes.txt": Buffer.from("new-v2\n") };
    const next = await stageWorkspace(runtime, binding, client.token, nextBytes);
    const requestId = `thread10-after-commit-${randomUUID()}`;
    const lost = next.commit({ requestId }).catch(() => undefined);
    const boundary = await poll(
      async () =>
        (
          await runtime.api<{ commitId: string; revision: string } | null>(
            `/__integration/workspace/${binding.workspaceId}/barrier`,
          )
        ).body,
      (value) => value?.commitId === next.commitId,
    );
    assert.ok(boundary);
    await runtime.stopAbruptly();
    await lost;
    await runtime.reopenSameStorage();
    const published = await next.commit({ requestId });
    assert.equal(published.status, 200);
    assert.equal(
      published.body.revision,
      boundary.revision,
      "Lost response must recover the actually committed pointer/receipt",
    );
    const changedIdentity = await next.commit({ manifestHash: "f".repeat(64) });
    assert.equal(
      changedIdentity.status,
      409,
      "Same commit identity with changed digest must conflict",
    );
    await next.release();
    const current = {
      ...binding,
      revision: published.body.revision,
      manifestHash: published.body.manifestHash,
    };
    await readWorkspace(runtime, binding, client.token, initialBytes);
    await readWorkspace(runtime, current, client.token, nextBytes);
    const stale = await runtime.api(
      `/v1/workspaces/${binding.workspaceId}/leases`,
      {
        requestId: randomUUID(),
        operationId: randomUUID(),
        bindingVersion: binding.bindingVersion,
        baseRevision: binding.revision,
        deadline: Date.now() + 30000,
      },
      "POST",
      client.token,
    );
    assert.equal(stale.status, 409, "Old base cannot acquire authority over current bytes");
    await readWorkspace(runtime, current, client.token, nextBytes);
    return {
      actualComputer: true,
      files: 3,
      binary: true,
      multiChunkBytes: initialBytes["multi.bin"].byteLength,
      uploadChunks: r0.chunks,
      interruptedChunks: interrupted.chunks,
      oldRevisionReadable: true,
      newRevisionReadable: true,
      originalReceiptRetried: true,
      changedCommitDigestStatus: 409,
      staleBaseStatus: 409,
      actualWorkerdKilled: true,
      committedCanarySurvived: true,
      interruptedMultiChunkValidationRejected: true,
      committedPointerReceiptOutboxBoundary: true,
      identicalCommitAfterLostResponse: true,
      independentHashes: Object.fromEntries(
        Object.entries(initialBytes).map(([path, data]) => [path, digest(data)]),
      ),
      limitation:
        "Verified reclamation and actual device replacement are separate required companion scenarios; local death is not cloud eviction",
    };
  } finally {
    const revoked = await roles.cleanup();
    await runtime.dispose();
    assert.ok(
      revoked.every((role) => role.state === "complete"),
      "Workspace fixture revocation remains pending/unknown",
    );
  }
}
