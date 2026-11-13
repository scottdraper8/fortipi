import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type {
  Manifest,
  OperationRequest,
  ResourceScope,
  UploadBegin,
  UploadCommit,
  WorkspaceOperationLease,
} from "../../packages/fortipi-contract/dist/index.js";
import type { DeploymentIdentity } from "../../scripts/verify-release-gates.ts";
import type { Installed } from "../distribution/install.ts";
import type { ScenarioEvidence } from "./evidence.ts";
import type { RoleContext } from "./roles.ts";

export interface LiveWorkspaceInput {
  installed: Installed;
  roles: RoleContext;
  deployment: Pick<DeploymentIdentity, "origin" | "deploymentId" | "publicConfigurationVersion">;
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Unmodified installed public client and Computer only. A local execution of
 * this port is engineering evidence, never a deployed/platform recovery claim. */
export async function runLiveWorkspace({
  installed,
  roles,
  deployment,
}: LiveWorkspaceInput): Promise<ScenarioEvidence> {
  assert.equal(roles.endpoint, deployment.origin);
  const module = (await import(
    pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/node`)).href
  )) as typeof import("../../packages/fortipi-client/dist/node.js");
  const deadline = Date.now() + 12 * 60000;
  const signal = AbortSignal.timeout(12 * 60000);
  const quotas: { phase: string; delayMs: number }[] = [];
  const credentials: string[] = [];
  const cleanup: {
    resource: string;
    state: "complete" | "unknown";
    code?: string;
    status?: number;
    pendingRecipients?: number;
  }[] = [];
  const uncertain = (resource: string, error: unknown) => ({
    resource,
    state: "unknown" as const,
    ...(error instanceof module.FortiPiError
      ? { code: error.code, ...(error.status === undefined ? {} : { status: error.status }) }
      : {}),
  });
  let lease: WorkspaceOperationLease | undefined;
  let uploadId: string | undefined;
  let committed = false;
  let released = false;
  let workspaceId: string | undefined;
  let writer: InstanceType<typeof module.FortiPiClient> | undefined;
  let result: ScenarioEvidence | undefined;
  let failure: unknown;
  let phase = "setup";
  let failurePhase = "";
  let transferAt = 0;
  let renewals = 0;

  // Only explicit retry-later refusals are retried, with the original input.
  // Transport loss/uncertain effects never creates a replacement operation.
  async function call<T>(
    phaseName: string,
    operation: () => Promise<T>,
    activeLease = false,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      phase = phaseName;
      try {
        if (activeLease) {
          assert.ok(writer && lease);
          // Bound request amplification without changing service budgets. This
          // is explicit public renewal, not a new operation after uncertainty.
          const wait = Math.max(0, transferAt + 15000 - Date.now());
          assert.ok(
            Date.now() + wait + 5000 < lease.expiresAt,
            "Lease cannot survive transfer pacing",
          );
          if (wait) await sleep(wait, undefined, { signal });
          if (lease.expiresAt - Date.now() < 25000) {
            const current = lease,
              activeWriter = writer;
            const renewal: Omit<OperationRequest<"renewWorkspaceLease">, "operationId"> = {
              path: { workspaceId: current.workspaceId, leaseId: current.leaseId },
              query: {},
              body: {
                requestId: randomUUID(),
                lease: current,
              },
            };
            lease = await call("renew", () =>
              activeWriter.operations.renewWorkspaceLease(renewal, { signal }),
            );
            renewals++;
          }
        }
        phase = phaseName;
        const value = await operation();
        if (activeLease) transferAt = Date.now();
        return value;
      } catch (error) {
        if (!(error instanceof module.FortiPiError) || attempt >= 2 || !error.retryable)
          throw error;
        const retryLater =
          error.code === "rate_limited" ||
          (["quota_paused", "quota_exceeded"].includes(error.code) &&
            error.details?.pressure?.action === "retry-later");
        const delayMs = Math.max(error.details?.retryAfterMs ?? 0, error.retryAfterMs ?? 0);
        if (
          !retryLater ||
          !Number.isSafeInteger(delayMs) ||
          delayMs <= 0 ||
          Date.now() + delayMs >= deadline ||
          ((activeLease || phaseName === "renew") &&
            (!lease || Date.now() + delayMs + 1000 >= lease.expiresAt))
        )
          throw error;
        quotas.push({ phase: phaseName, delayMs });
        await sleep(delayMs, undefined, { signal });
      }
    }
  }
  const releaseRequestId = randomUUID();
  async function release() {
    assert.ok(writer && workspaceId && lease);
    const input = {
      path: { workspaceId, leaseId: lease.leaseId },
      query: {},
      body: { requestId: releaseRequestId, lease, reason: committed ? "completed" : "cancelled" },
    } as const;
    const activeWriter = writer;
    const receipt = await call("release", () =>
      activeWriter.operations.releaseWorkspaceLease(input),
    );
    assert.equal(receipt.leaseId, lease.leaseId);
    assert.equal(receipt.released, true);
    released = true;
  }
  try {
    const configuration = await roles.call({
      operationId: "getConfiguration",
      path: {},
      query: {},
      body: undefined,
    });
    assert.equal(configuration.version, deployment.publicConfigurationVersion);
    const create = { requestId: randomUUID(), config: { kind: "computer" as const } };
    const initial = await roles.call({
      operationId: "createWorkspace",
      path: {},
      query: {},
      body: create,
    });
    workspaceId = initial.workspaceId;
    assert.equal(initial.config.kind, "computer");
    const client = async (actions: string[]) => {
      const resources: ResourceScope = {
        agentIds: [],
        conversationIds: [],
        workspaceIds: [initial.workspaceId],
        executorIds: [],
        backendIds: [],
        tools: [],
        actions,
      };
      const issued = await roles.issue({
        requestId: randomUUID(),
        role: "client",
        expiresAt: deadline + 120000,
        grants: [{ grantId: randomUUID(), version: 1, resources }],
      });
      credentials.push(issued.credential.credentialId);
      return new module.FortiPiClient({
        endpoint: roles.endpoint,
        credentials: async () => issued.token,
        allowLoopbackHttp: new URL(roles.endpoint).protocol === "http:",
        timeoutMs: 20000,
      });
    };
    const writable = await client(["workspace.write"]);
    writer = writable;
    const reader = await client(["workspace.read", "workspaces.read"]);
    const protocol = await reader.negotiate(signal);
    assert.equal(protocol.deploymentId, deployment.deploymentId);
    assert.deepEqual(protocol.infrastructure, configuration.infrastructure);
    const files = {
      "notes.txt": Buffer.from("old-v1\n"),
      "binary.bin": Buffer.from([0, 255, 13, 10, 128, 1]),
      "multi.bin": Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => (i * 31 + 1010) % 256),
    };
    const entries = Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => ({
        type: "file" as const,
        path,
        mode: 420 as const,
        size: bytes.byteLength,
        sha256: hash(bytes),
      }));
    const bounds = protocol.infrastructure.bounds;
    assert.ok(entries.length <= bounds.manifestEntries);
    assert.ok(entries.reduce((n, entry) => n + entry.size, 0) <= bounds.snapshotBytes);
    assert.ok(entries.every((entry) => entry.size <= bounds.fileBytes));
    const chunkBytes = Math.min(262144, protocol.limits.chunkBytes);
    assert.ok(Number.isSafeInteger(chunkBytes) && chunkBytes > 0);
    const manifest: Manifest = { version: 1, entries };
    // Independent fixed-shape public canonical preimage; no product digest helper.
    const manifestHash = hash(
      `fortipi:manifest:v1\n${JSON.stringify({
        entries: entries.map(({ mode, path, sha256, size, type }) => ({
          mode,
          path,
          sha256,
          size,
          type,
        })),
        version: 1,
      })}`,
    );
    const acquire = {
      path: { workspaceId: initial.workspaceId },
      query: {},
      body: {
        requestId: randomUUID(),
        operationId: randomUUID(),
        bindingVersion: initial.bindingVersion,
        baseRevision: initial.revision,
        deadline,
      },
    };
    lease = await call("acquire", () =>
      writable.operations.acquireWorkspaceLease(acquire, { signal }),
    );
    const begin: UploadBegin = {
      requestId: randomUUID(),
      operationId: lease.operationId,
      commitId: randomUUID(),
      lease,
      baseRevision: initial.revision,
      manifest,
      manifestHash,
      mutations: entries.map(({ path, mode, size, sha256 }) => ({
        kind: "put",
        path,
        mode,
        size,
        sha256,
      })),
      blobs: entries.map((entry) => {
        const bytes = files[entry.path as keyof typeof files];
        return {
          sha256: entry.sha256,
          chunks: {
            chunkBytes,
            chunkHashes: Array.from(
              { length: Math.ceil(bytes.byteLength / chunkBytes) },
              (_, index) => hash(bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes)),
            ),
          },
        };
      }),
    };
    const opened = await call(
      "begin",
      () => writable.uploads.begin(initial.workspaceId, begin, { signal }),
      true,
    );
    uploadId = opened.uploadId;
    let chunks = 0;
    for (const entry of entries) {
      const bytes = files[entry.path as keyof typeof files];
      for (let at = 0, index = 0; at < bytes.byteLength; at += chunkBytes, index++) {
        const part = bytes.subarray(at, Math.min(bytes.byteLength, at + chunkBytes));
        const input = {
          path: {
            workspaceId: initial.workspaceId,
            uploadId,
            sha256: entry.sha256,
            chunkIndex: index,
          },
          query: { length: part.byteLength, sha256: hash(part) },
          body: new Uint8Array(part),
        };
        await call("chunk", () => writable.uploads.chunk(input, { signal }), true);
        chunks++;
      }
    }
    const validated = await call(
      "validate",
      () => writable.uploads.validate(initial.workspaceId, opened.uploadId, { signal }),
      true,
    );
    const commit: UploadCommit = {
      requestId: randomUUID(),
      operationId: lease.operationId,
      workspaceId: initial.workspaceId,
      uploadId,
      commitId: begin.commitId,
      stageId: validated.stageId,
      lease,
      baseRevision: initial.revision,
      manifestHash,
    };
    const receipt = await call(
      "commit",
      () => writable.uploads.commit(initial.workspaceId, opened.uploadId, commit, { signal }),
      true,
    );
    committed = true;
    assert.equal(receipt.providerKind, "computer");
    assert.equal(receipt.manifestHash, manifestHash);
    assert.notEqual(receipt.revision, initial.revision);
    await release();
    assert.deepEqual(
      await call("receipt-retry", () =>
        writable.uploads.commit(initial.workspaceId, opened.uploadId, commit, { signal }),
      ),
      receipt,
    );
    assert.deepEqual(
      await call("reader-receipt", () =>
        reader.uploads.receipt(
          initial.workspaceId,
          receipt.commitId,
          { commitDigest: receipt.commitDigest },
          { signal },
        ),
      ),
      receipt,
    );

    async function readPublished() {
      const current = await call("reader-binding", () =>
        reader.workspaces.get(initial.workspaceId, { signal }),
      );
      assert.equal(current.revision, receipt.revision);
      assert.equal(current.manifestHash, manifestHash);
      const described = await call("reader-manifest", () =>
        reader.workspaces.manifest(initial.workspaceId, { revision: receipt.revision }, { signal }),
      );
      assert.deepEqual(described.manifest, manifest);
      for (const entry of entries) {
        const actual = new Uint8Array(entry.size);
        for (let at = 0; at < entry.size; at += chunkBytes) {
          const end = Math.min(entry.size - 1, at + chunkBytes - 1);
          const bytes = await call("reader-bytes", () =>
            reader.workspaces.read(
              initial.workspaceId,
              { revision: receipt.revision, path: entry.path },
              { signal, range: { start: at, end } },
            ),
          );
          assert.equal(bytes.byteLength, end - at + 1);
          assert.equal(
            hash(bytes),
            hash(files[entry.path as keyof typeof files].subarray(at, end + 1)),
          );
          actual.set(bytes, at);
        }
        assert.equal(hash(actual), entry.sha256, "Independent published file bytes changed");
      }
    }
    await readPublished();
    await assert.rejects(
      () =>
        call("write-only-read", () =>
          writable.workspaces.read(
            initial.workspaceId,
            {
              revision: receipt.revision,
              path: "notes.txt",
            },
            { signal },
          ),
        ),
      (error: unknown) => error instanceof module.FortiPiError && error.status === 403,
      "A write-only application role cannot read public workspace bytes",
    );
    const stale = {
      ...acquire,
      body: {
        ...acquire.body,
        requestId: randomUUID(),
        operationId: randomUUID(),
        deadline,
      },
    };
    const conflict = (error: unknown) =>
      error instanceof module.FortiPiError && error.status === 409;
    await assert.rejects(
      () => call("stale-base", () => writable.operations.acquireWorkspaceLease(stale, { signal })),
      conflict,
      "Stale-base CAS must reject instead of acquiring authority over the published revision",
    );
    await assert.rejects(
      () =>
        call("changed-commit", () =>
          writable.uploads.commit(
            initial.workspaceId,
            opened.uploadId,
            { ...commit, manifestHash: "0".repeat(64) },
            { signal },
          ),
        ),
      conflict,
      "A reused commit identity with changed digest must conflict",
    );
    await readPublished();
    result = {
      observation: {
        workspaceId,
        actualComputer: true,
        files: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
        multiChunkBytes: files["multi.bin"].byteLength,
        chunkBytes,
        chunks,
        transferIntervalMs: 15000,
        publicLeaseRenewals: renewals,
        originalRevision: initial.revision,
        publishedRevision: receipt.revision,
        retainedReceiptRetriedAfterRelease: true,
        independentReaderReceiptMatches: true,
        writeOnlyReadStatus: 403,
        staleBaseLeaseStatus: 409,
        changedCommitDigestStatus: 409,
        publishedPointerManifestAndAllBytesUnchangedAfterRejection: true,
        quotaWaits: quotas,
        cleanup,
        workspaceRetained: true,
      },
      oracle:
        "Independent three-file lengths, per-chunk SHA256 and full SHA256 must match actual Computer publication; exact receipt survives retry; stale-base CAS and changed commit identity reject without changing the published revision or bytes; write-only role cannot read",
      sensitivity: [
        "Actual stale-base lease CAS409 and changed commit digest409, followed by independent pointer/manifest/all-byte readback",
      ],
      limitations: [
        "No lost-response, crash/platform recovery, separate-host, Paid backend or account-ceiling proof",
        "Public API exposes no workspace deletion: committed workspace/revision remains; only owned uploads/leases/credentials are cleaned",
      ],
    };
  } catch (error) {
    failure = error;
    failurePhase = phase;
  } finally {
    if (writer && workspaceId && uploadId && !committed) {
      try {
        const activeWriter = writer,
          activeWorkspace = workspaceId,
          activeUpload = uploadId;
        await call("abort", () => activeWriter.uploads.abort(activeWorkspace, activeUpload));
        cleanup.push({ resource: "upload", state: "complete" });
      } catch (error) {
        try {
          const activeWriter = writer,
            activeWorkspace = workspaceId,
            activeUpload = uploadId;
          const status = await call("abort-status", () =>
            activeWriter.uploads.get(activeWorkspace, activeUpload),
          );
          cleanup.push(
            status.state === "aborted"
              ? { resource: "upload", state: "complete" }
              : uncertain("upload", error),
          );
        } catch {
          cleanup.push(uncertain("upload", error));
        }
      }
    }
    if (lease && !released) {
      try {
        await release();
      } catch (error) {
        cleanup.push(uncertain("lease", error));
      }
    }
    if (released) cleanup.push({ resource: "lease", state: "complete" });
    for (const id of credentials) {
      try {
        const cleanupDeadline = Date.now() + 120000;
        let revoked = await roles.revoke(id);
        while (revoked.state !== "complete" && Date.now() + 10000 < cleanupDeadline) {
          await sleep(10000);
          revoked = await roles.revoke(id);
        }
        cleanup.push({
          resource: id,
          state: revoked.state === "complete" ? "complete" : "unknown",
          pendingRecipients: revoked.pendingRecipients.length,
        });
      } catch (error) {
        cleanup.push(uncertain(id, error));
      }
    }
    roles.assertSanitized(cleanup);
  }
  if (failure || cleanup.some((row) => row.state !== "complete"))
    throw Object.assign(
      new Error("Public workspace scenario or owned cleanup failed", { cause: failure }),
      { cleanup, phase: failure ? failurePhase : "cleanup", retainedWorkspaceId: workspaceId },
    );
  assert.ok(result);
  roles.assertSanitized(result);
  return result;
}
