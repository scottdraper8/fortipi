import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { LocalWorkspace } from "../../../../packages/fortipi-executor/dist/index.js";
import { SessionTransport } from "../../../../packages/fortipi-executor/dist/index.js";
import type * as D from "../../src/boundary/dto.js";
import { nativeService } from "../execution/native-service.ts";
import { bytes, hashes } from "./fixture-state.ts";
import { poll } from "./runtime.ts";
import { readWorkspace, stageWorkspace } from "./workspace-portability.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function publicPort(n: Awaited<ReturnType<typeof nativeService>>) {
  const { url } = await n.h.server.listen(),
    endpoint = new URL(url).origin;
  return {
    endpoint,
    api: async <T>(path: string, body?: unknown, method?: string, token?: string) => {
      const response = await fetch(`${endpoint}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      });
      return { status: response.status, body: (await response.json()) as T };
    },
  };
}
/** Lose the real native apply acknowledgment after actual bytes and journal have
 * persisted. Reconnect the same owner and recover the original public receipt. */
export async function localApplyReceipt() {
  const n = await nativeService({ approve: false, reconciliation: true });
  const reconnect = new AbortController();
  let connected: Promise<void> | undefined;
  const local = n.runtime.locals.get("root");
  assert.ok(local);
  const request = local.request.bind(local);
  try {
    const port = await publicPort(n);
    // Metadata inspection is coordinator-only; transfer/publication below use
    // the original least-privilege application role throughout.
    const current = await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`);
    assert.equal(current.status, 200);
    const stage = await stageWorkspace(port, current.body, n.actor.token, bytes);
    let dropped = false;
    local.request = async (input) => {
      const result = await request(input);
      if (input.kind === "apply" && input.operationId === stage.lease.operationId && !dropped) {
        dropped = true;
        assert.ok(n.runtime.session?.socket);
        n.runtime.session.socket.close(4010, "owned fixture lost apply acknowledgment");
      }
      return result;
    };
    const interrupted = stage.commit().catch(() => undefined);
    await poll(async () => dropped, Boolean);
    await poll(
      async () => n.runtime.connected,
      (value) => !value,
    );
    const journal = n.f.ledger.local(stage.lease.operationId);
    assert.ok(journal);
    assert.equal(journal.observation.state, "applied");
    assert.equal(
      journal.observation.receipt,
      undefined,
      "Physical apply alone is not metadata publication/receipt",
    );
    const effects = journal.journal.length;
    assert.ok(effects > 0);
    for (const [path, expected] of Object.entries(hashes))
      assert.equal(hash(await readFile(resolve(n.f.rootPath, path))), expected);
    const beforeReceipt = await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`);
    assert.equal(
      beforeReceipt.body.revision,
      current.body.revision,
      "Unacknowledged native apply cannot become a fabricated published revision",
    );
    assert.equal(
      n.f.ledger.rootAvailable(n.f.root.key),
      false,
      "Actual local journal stays pinned until its receipt",
    );
    const session = new SessionTransport(n.runtime.http, n.runtime);
    n.runtime.session = session;
    connected = session
      .connect(reconnect.signal, {
        type: "executor.register",
        requestId: crypto.randomUUID(),
        payload: {
          executorId: n.f.profile.executorId,
          generation: n.f.profile.executorGeneration,
          ...n.runtime.http.ledgerIdentity(),
          protocolVersion: "1.0",
          schemaVersion: "1.0.0",
          platform: process.platform as "darwin" | "linux" | "win32",
          caseBehavior: n.f.root.identity.caseBehavior,
          confinement: "host",
          capabilities: ["shell", "local-workspace", "snapshots"],
          rootBindingIds: ["root"],
          transferLimits: n.runtime.http.transferLimits(),
        },
      })
      .catch(() => {});
    await poll(async () => n.runtime.connected, Boolean);
    await interrupted;
    const receipt = await stage.commit();
    assert.equal(receipt.status, 200);
    assert.deepEqual(
      await stage.commit(),
      receipt,
      "Retry after a lost apply acknowledgment must retain the exact committed receipt",
    );
    await poll(
      async () => n.f.ledger.local(stage.lease.operationId)?.observation.receipt,
      (value) => value?.commitDigest === receipt.body.commitDigest,
    );
    assert.equal(
      n.f.ledger.local(stage.lease.operationId)?.journal.length,
      effects,
      "Receipt recovery cannot repeat native filesystem effects",
    );
    assert.equal(n.f.ledger.rootAvailable(n.f.root.key), true);
    assert.equal(
      await readFile(n.marker, "utf8").catch(() => ""),
      "",
      "Non-job workspace apply must never spawn a tool",
    );
    const binding = {
      ...current.body,
      revision: receipt.body.revision,
      manifestHash: receipt.body.manifestHash,
    };
    await readWorkspace(port, binding, n.actor.token, bytes);
    await stage.release();
    return {
      actualPublicLocalTransfer: true,
      actualNativeOwner: process.platform,
      files: 3,
      multiChunkBytes: bytes["multi.bin"].byteLength,
      uploadedChunks: stage.chunks,
      droppedRealApplyAcknowledgment: true,
      appliedBeforePublishedReceipt: true,
      rootPinnedUntilReceipt: true,
      originalCommitId: receipt.body.commitId,
      originalReceiptRetried: true,
      journalEffectsBeforeAndAfterRecovery: effects,
      processStarts: 0,
      independentHashes: hashes,
      limitations: [
        "Actual same-owner transport disconnection/reconnection, filesystem and SQLite journal; not native process death or separate device proof",
      ],
    };
  } finally {
    local.request = request;
    reconnect.abort();
    await connected;
    await n.close();
  }
}
/** An actual native owner rejects a prepared operation after external drift.
 * Metadata rejection alone is insufficient: independent disk hashes are the oracle. */
export async function rejectedLocalBytes(Constructor?: typeof LocalWorkspace) {
  const n = await nativeService({ approve: false, reconciliation: true });
  try {
    // The service fixture's tool remains unapproved and never reserves/executes
    // this workspace. Canonical staging is an independent non-job operation.
    const binding = n.f.profile.bindings[0]!;
    if (Constructor)
      n.runtime.locals.set(
        "root",
        new Constructor(n.f.root, binding, n.f.profile, n.f.ledger, n.runtime.staging),
      );
    const port = await publicPort(n);
    let current = (await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`)).body;
    const original = Buffer.from("seed1010-canonical-original\n");
    const r0 = await stageWorkspace(port, current, n.actor.token, { "notes.txt": original });
    const receipt = await r0.commit();
    assert.equal(receipt.status, 200);
    await r0.release();
    current = {
      ...current,
      revision: receipt.body.revision,
      manifestHash: receipt.body.manifestHash,
    };
    assert.deepEqual(await readFile(resolve(n.f.rootPath, "notes.txt")), original);
    const staged = await stageWorkspace(port, current, n.actor.token, {
      "notes.txt": Buffer.from("seed1010-prepared-replacement\n"),
    });
    const drift = Buffer.from("seed1010-external-current\n");
    await writeFile(resolve(n.f.rootPath, "notes.txt"), drift);
    const rejected = await staged.commit();
    assert.equal(
      rejected.status,
      409,
      "A prepared local operation cannot publish over changed canonical bytes",
    );
    const observed = await readFile(resolve(n.f.rootPath, "notes.txt"));
    assert.equal(
      hash(observed),
      hash(drift),
      "Rejected stale canonical CAS must preserve the independently observed old bytes",
    );
    const after = await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`);
    assert.equal(after.body.revision, current.revision);
    await staged.abort();
    await staged.release();
    return {
      actualPublicStaging: true,
      actualNativeOwner: process.platform,
      rejectionStatus: rejected.status,
      canonicalHashBefore: hash(drift),
      canonicalHashAfter: hash(observed),
      metadataRevisionUnchanged: true,
      limitations: [
        "Deliberate external drift in an owned native root; no live device or cloud-runtime claim",
      ],
    };
  } finally {
    await n.close();
  }
}
