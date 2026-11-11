import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { manifestDigest } from "fortipi-contract";
import { createTestHarness } from "wrangler";
import type * as D from "../../src/boundary/dto.js";
import { root, workspaceConfig } from "./harness.ts";
import { workspaceTarget } from "./target.ts";

test("local empty upload settles before preparation and receipt retry binds its actual upload without reapply", {
  timeout: 30000,
}, async () => {
  const server = createTestHarness({
    root,
    workers: [
      {
        config: {
          ...workspaceConfig(),
          main:
            process.env.FORTIPI_LOCAL_TEST_ENTRY ??
            resolve(root, "apps/worker/test/workspace/local-upload-worker.ts"),
        },
      },
    ],
  });
  const outcome = async <T>(input: unknown, bootstrap = false): Promise<D.Outcome<T>> =>
    (
      await server.fetch("/rpc", {
        method: "POST",
        headers: bootstrap ? { "x-test-bootstrap": "1" } : { "x-test-write-only": "1" },
        body: JSON.stringify(input),
      })
    ).json() as Promise<D.Outcome<T>>;
  const call = async <T>(input: unknown, bootstrap = false, failureMessage = ""): Promise<T> => {
    const result = await outcome<T>(input, bootstrap);
    if (!result.ok) assert.fail(`${failureMessage} ${JSON.stringify(result)}`);
    return result.value;
  };
  try {
    await server.listen();
    const binding = await call<D.WorkspaceBinding>(
      {
        kind: "binding",
        input: {
          requestId: "local-empty-binding",
          binding: {
            workspaceId: "workspace",
            bindingVersion: 1,
            config: { kind: "local", executorId: "executor", rootBindingId: "root" },
          },
          expectedVersion: null,
          executor: { executorId: "executor", generation: 1 },
          import: { revision: "local-base", manifest: { version: 1, entries: [] } },
        },
      },
      true,
    );
    const lease = await call<D.Lease>({
      kind: "acquire",
      input: await workspaceTarget("local-empty-operation", binding.revision, {
        target: { kind: "executor", executorId: "executor", generation: 1 },
      }),
    });
    const sha256 = createHash("sha256").update(new Uint8Array()).digest("hex");
    const manifest: D.Manifest = {
      version: 1,
      entries: [{ type: "file", path: "empty", mode: 420, size: 0, sha256 }],
    };
    const manifestHash = await manifestDigest(manifest);
    const begun = await call<Extract<D.OperationResponse<"beginUpload">, { status: 201 }>>({
      kind: "begin",
      input: {
        operationId: "beginUpload",
        path: { workspaceId: "workspace" },
        query: {},
        body: {
          requestId: "local-empty-upload",
          operationId: lease.operationId,
          commitId: "local-empty-commit",
          lease,
          baseRevision: lease.baseRevision,
          manifest,
          manifestHash,
          mutations: [{ kind: "put", path: "empty", mode: 420, size: 0, sha256 }],
          blobs: [{ sha256, chunks: { chunkBytes: 65536, chunkHashes: [] } }],
        },
      },
    });
    const path = { workspaceId: "workspace", uploadId: begun.body.uploadId };
    const validation = {
      kind: "validate",
      input: { operationId: "validateUpload", path, query: {} },
    };
    const waiting = await outcome<unknown>(validation);
    assert.equal(waiting.ok, false, "Preparation raced an unacknowledged empty transfer");
    if (!waiting.ok)
      assert.equal(waiting.code, "interrupted", "Local empty upload raced its transfer settlement");
    const validated = await call<Extract<D.OperationResponse<"validateUpload">, { status: 200 }>>(
      validation,
      false,
      "Local empty upload raced its transfer settlement",
    );
    const commit = {
      kind: "commit",
      input: {
        operationId: "commitUpload",
        path,
        query: {},
        body: {
          requestId: "local-empty-commit-request",
          stageId: validated.body.stageId,
          uploadId: path.uploadId,
          commitId: "local-empty-commit",
          operationId: lease.operationId,
          workspaceId: "workspace",
          baseRevision: lease.baseRevision,
          manifestHash,
          lease,
        },
      },
    };
    const lost = await outcome<unknown>(commit);
    assert.equal(lost.ok, false, "Lost receipt acknowledgment was not exercised");
    if (!lost.ok)
      assert.equal(lost.code, "interrupted", "Local receipt omitted its retained upload identity");
    const receipt = await call<Extract<D.OperationResponse<"commitUpload">, { status: 200 }>>(
      commit,
      false,
      "Local receipt omitted its retained upload identity",
    );
    assert.equal(receipt.body.providerKind, "local");
    assert.deepEqual(await (await server.fetch("/local-state")).json(), {
      opens: 1,
      observes: 2,
      applies: 1,
      receipts: 2,
    });
  } finally {
    await server.close();
  }
});
