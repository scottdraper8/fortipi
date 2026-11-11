import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { manifestDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { RecoveryProcess } from "./recovery-process.ts";
import { workspaceTarget } from "./target.ts";

test("persistent Wrangler reopens committed bytes and receipt after death before response", {
  timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-workspace-recovery-"));
  const runtime = new RecoveryProcess(directory);
  async function call<T>(input: unknown): Promise<T> {
    const response = await fetch(`${runtime.url}/rpc`, {
      method: "POST",
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as D.Outcome<T>;
    if (!result.ok) assert.fail(JSON.stringify(result));
    return result.value;
  }
  try {
    await runtime.start();
    const seeded = (await (
      await fetch(`${runtime.url}/seed`)
    ).json()) as D.Outcome<D.WorkspaceBinding>;
    if (!seeded.ok) assert.fail(JSON.stringify(seeded));
    const lease = await call<D.Lease>({
      kind: "acquire",
      input: await workspaceTarget("recovery-operation", seeded.value.revision),
    });
    const bytes = new TextEncoder().encode("independent-persistent-canary");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifest: D.Manifest = {
      version: 1,
      entries: [{ path: "canary.txt", type: "file", mode: 420, size: bytes.length, sha256 }],
    };
    const manifestHash = await manifestDigest(manifest);
    const begun = await call<{ status: 201; body: D.UploadStatus }>({
      kind: "begin",
      input: {
        operationId: "beginUpload",
        path: { workspaceId: "workspace" },
        query: {},
        body: {
          requestId: "recovery-upload",
          baseRevision: lease.baseRevision,
          lease,
          operationId: lease.operationId,
          commitId: "recovery-commit",
          manifest,
          manifestHash,
          mutations: [
            {
              kind: "put",
              path: "canary.txt",

              sha256,
              size: bytes.length,
              mode: 420,
            },
          ],
        },
      },
    });
    await call({
      kind: "chunk",
      input: {
        operationId: "putUploadChunk",
        path: { workspaceId: "workspace", uploadId: begun.body.uploadId, sha256, chunkIndex: 0 },
        query: { length: bytes.length, sha256 },
      },
      bytes: [...bytes],
    });
    const validation = await call<{ status: 200; body: D.UploadValidation }>({
      kind: "validate",
      input: {
        operationId: "validateUpload",
        path: { workspaceId: "workspace", uploadId: begun.body.uploadId },
        query: {},
      },
    });
    const commit = {
      kind: "commit",
      input: {
        operationId: "commitUpload",
        path: { workspaceId: "workspace", uploadId: begun.body.uploadId },
        query: {},
        body: {
          requestId: "crash-after-commit",
          stageId: validation.body.stageId,
          commitId: "recovery-commit",
          uploadId: begun.body.uploadId,
          operationId: lease.operationId,
          workspaceId: "workspace",
          lease,
          manifestHash,
          baseRevision: lease.baseRevision,
        },
      },
    };
    const lostResponse = call(commit).catch(() => undefined);
    let reached = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await (await fetch(`${runtime.url}/barrier`)).text()) === "ready") {
        reached = true;
        break;
      }
      await delay(20);
    }
    assert.equal(reached, true, "Did not reach actual post-transaction barrier");
    await runtime.kill();
    await lostResponse;
    await runtime.start();
    const receipt = (await call<{ status: 200; body: D.CommitReceipt }>(commit)).body;
    const response = await fetch(
      `${runtime.url}/read?revision=${receipt.revision}&path=canary.txt`,
    );
    assert.equal(response.status, 200);
    assert.equal(
      createHash("sha256")
        .update(new Uint8Array(await response.arrayBuffer()))
        .digest("hex"),
      sha256,
    );
    assert.deepEqual((await call<{ status: 200; body: D.CommitReceipt }>(commit)).body, receipt);
    const binding = (
      await call<{ status: 200; body: D.WorkspaceBinding }>({
        kind: "describe",
        input: { operationId: "describeWorkspace", path: { workspaceId: "workspace" }, query: {} },
      })
    ).body;
    assert.equal(binding.revision, receipt.revision);
    assert.equal(binding.manifestHash, manifestHash);
  } finally {
    await runtime.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
