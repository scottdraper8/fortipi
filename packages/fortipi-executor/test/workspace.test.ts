import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { CommitReceipt, LocalObservation, LocalPrepare } from "fortipi-contract/executor";
import { commitDigest, localStageDigest, manifestDigest } from "fortipi-contract/executor";
import { adapter, defaults } from "../dist/config.js";
import { hash } from "../dist/policy.js";
import { HttpTransport } from "../dist/transport.js";
import { LocalWorkspace } from "../dist/workspace/local.js";
import type { Manifest } from "../dist/workspace/manifest.js";
import { scan } from "../dist/workspace/manifest.js";
import { Snapshots } from "../dist/workspace/snapshot.js";
import { Staging } from "../dist/workspace/staging.js";
import {
  assignment,
  credential,
  fixture,
  importRoot,
  prepare,
  receiptScope,
  requestScope,
} from "./fixtures/daemon.ts";
import { relayFixture, snapshotFixture } from "./fixtures/transport.ts";

async function setup() {
  const f = await fixture(),
    http = new HttpTransport(f.profile, fetch, true),
    staging = new Staging(join(f.directory, "staging"), f.ledger, http);
  await staging.initialize();
  const binding = f.profile.bindings[0];
  if (!binding) throw new Error("binding missing");
  const local = new LocalWorkspace(f.root, binding, f.profile, f.ledger, staging);
  await importRoot(local);
  return { ...f, staging, local };
}
async function staged(f: Awaited<ReturnType<typeof setup>>, name = "alpha"): Promise<LocalPrepare> {
  const a = await assignment("not executed"),
    base = prepare(a, f.initial.manifestHash),
    bytes = Buffer.from("expected committed content"),
    sha256 = hash(bytes),
    uploadId = randomUUID();
  const manifest: Manifest = {
    version: 1,
    entries: [{ path: name, type: "file", mode: 420, size: bytes.length, sha256 }],
  };
  const relay = await relayFixture(bytes),
    oldOrigin = f.profile.origin;
  f.profile.origin = relay.origin;
  try {
    await f.staging.receive({
      transferId: randomUUID(),
      attemptId: randomUUID(),
      deploymentId: f.profile.deploymentId,
      direction: "to-executor",
      purpose: "local-stage",
      workspaceId: base.workspaceId,
      bindingVersion: base.bindingVersion,
      operationId: base.operationId,
      operationDigest: base.operationDigest,
      jobId: a.identity.jobId,
      executionId: a.identity.executionId,
      executorId: f.profile.executorId,
      executorGeneration: f.profile.executorGeneration,
      credential: base.credential,
      consumer: f.profile.resources,
      baseRevision: base.baseRevision,
      lease: base.lease,
      content: {
        kind: "workspace-file",
        path: name,
        manifestHash: await manifestDigest(manifest),
        uploadId,
      },
      fileSha256: sha256,
      size: bytes.length,
      chunkBytes: bytes.length,
      chunkHashes: [sha256],
      expiresAt: Date.now() + 10000,
      deadline: base.deadline,
    });
  } finally {
    f.profile.origin = oldOrigin;
    await relay.close();
  }
  const mutations = [
    {
      kind: "put" as const,
      entry: manifest.entries[0] as Extract<Manifest["entries"][number], { type: "file" }>,
      blob: sha256,
    },
  ];
  const stage = await f.staging.register({
    uploadId,
    operationId: base.operationId,
    operationDigest: base.operationDigest,
    workspaceId: "workspace",
    bindingVersion: 1,
    baseRevision: "r0",
    manifest,
    mutations,
  });
  return {
    ...base,
    mode: {
      kind: "staged-change",
      uploadId,
      stagedDigest: stage.stagedDigest,
      postManifestHash: await manifestDigest(manifest),
      manifest,
      mutations: [{ kind: "put", path: name, sha256, size: bytes.length, mode: 420 }],
    },
  };
}
async function receipt(
  request: LocalPrepare,
  observation: LocalObservation,
): Promise<CommitReceipt> {
  if (observation.state !== "applied") throw new Error("applied observation required");
  const commitHash = await commitDigest({
    commitId: request.commitId,
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    baseRevision: request.baseRevision,
    manifestHash: observation.postManifestHash,
    leaseIdentity: request.lease,
    storage: {
      kind: "local",
      preparationId: observation.preparationId,
      observationSeq: observation.observationSeq,
      preManifestHash: observation.preManifestHash,
      postManifestHash: observation.postManifestHash,
    },
    ...(request.mode.kind === "staged-change" ? { uploadId: request.mode.uploadId } : {}),
    ...(request.lease.ownerKind === "job" ? { jobId: request.lease.jobId } : {}),
  });
  return {
    commitId: request.commitId,
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    baseRevision: request.baseRevision,
    revision: "r1",
    manifestHash: observation.postManifestHash,
    sourceFactId: "fact",
    committedAt: Date.now(),
    providerKind: "local",
    preparationId: observation.preparationId,
    observationSeq: observation.observationSeq,
    commitDigest: commitHash,
    ...(request.lease.ownerKind === "job" ? { jobId: request.lease.jobId } : {}),
  };
}
test("prepare changes no canonical bytes; apply once, lost ack observes; receipt is separate, recoverable after lease expiry", async () => {
  const f = await setup();
  try {
    const request = await staged(f),
      prepared = await f.local.request(request);
    assert.notDeepEqual(
      request.credential,
      f.profile.credential,
      "app authority must differ from executor transport credential",
    );
    assert.ok("state" in prepared);
    assert.equal(prepared.state, "prepared");
    assert.equal((await scan(f.root, defaults)).manifestHash, f.initial.manifestHash);
    const preparationId = "preparationId" in prepared ? prepared.preparationId : "";
    const apply = { ...requestScope(request), kind: "apply" as const, preparationId };
    await assert.rejects(
      f.local.request({ ...apply, credential: f.profile.credential }),
      /lease identity/,
    );
    const applied = (await f.local.request(apply)) as LocalObservation;
    assert.equal(applied.state, "applied");
    const bytes = await readFile(join(f.rootPath, "alpha"), "utf8");
    assert.equal(bytes, "expected committed content");
    assert.deepEqual(await f.local.request(apply), applied);
    assert.equal(f.ledger.local(request.operationId)?.journal.length, 1);
    const proof = await receipt(request, applied);
    const expired = { ...request, lease: { ...request.lease, expiresAt: 0 } };
    const observed = await f.local.request({
      ...requestScope(expired),
      kind: "observe",
      preparationId,
    });
    assert.ok("state" in observed);
    assert.equal(observed.state, "applied");
    await assert.rejects(
      f.local.request({ ...requestScope(expired), kind: "apply", preparationId }),
      /expired/,
    );
    assert.equal(f.ledger.rootAvailable(f.root.key), false, "apply ack cannot release receipt pin");
    const ack = await f.local.request({
      ...receiptScope(expired),
      kind: "receipt",
      preparationId,
      receipt: proof,
    });
    assert.equal("persisted" in ack && ack.persisted, true);
    assert.equal(f.ledger.rootAvailable(f.root.key), true);
    assert.deepEqual(
      await f.local.request({
        ...receiptScope(expired),
        kind: "receipt",
        preparationId,
        receipt: proof,
      }),
      ack,
    );
    assert.equal(f.local.binding.revision, "r1");
    assert.equal(
      f.ledger.local(request.operationId)?.observation.receipt?.commitDigest,
      proof.commitDigest,
    );
  } finally {
    await f.cleanup();
  }
});
test("explicit local import establishes a nonempty revision once; absence, wrong consent, drift and quarantine cannot fabricate history", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.rootPath, "operator-file"), "operator approved bytes");
    const actual = await scan(f.root, defaults),
      binding = f.profile.bindings[0];
    if (!binding) throw new Error("binding missing");
    binding.manifestHash = actual.manifestHash;
    const staging = new Staging(
      join(f.directory, "staging"),
      f.ledger,
      new HttpTransport(f.profile, fetch, true),
    );
    await staging.initialize();
    const local = new LocalWorkspace(f.root, binding, f.profile, f.ledger, staging),
      read = {
        kind: "snapshot" as const,
        operationId: "inspect",
        workspaceId: "workspace",
        rootBindingId: "root",
        bindingVersion: 1,
        executorId: "executor",
        executorGeneration: 7,
        credential,
        revision: "r0",
        deadline: Date.now() + 10000,
      };
    await assert.rejects(local.request(read), /revision_unavailable/);
    const proposal = local.importProposal("import_once");
    await assert.rejects(
      local.importBinding({ ...proposal, approvalDigest: "0".repeat(64) }),
      /approval/,
    );
    const receipt = await local.importBinding(proposal);
    assert.equal(receipt.manifestHash, actual.manifestHash);
    assert.deepEqual(receipt.manifest, actual.manifest);
    assert.deepEqual(await local.importBinding(proposal), receipt);
    const snapshot = await local.request(read);
    assert.ok("kind" in snapshot);
    assert.equal(snapshot.kind, "snapshot");
    if ("kind" in snapshot && snapshot.kind === "snapshot")
      assert.equal(snapshot.result.manifestHash, actual.manifestHash);
    const recovered = new LocalWorkspace(f.root, { ...binding }, f.profile, f.ledger, staging);
    assert.deepEqual(await recovered.importBinding(proposal), receipt);
    await writeFile(join(f.rootPath, "operator-file"), "external drift");
    await assert.rejects(local.importBinding(proposal), /local_drift/);
    f.ledger.pin(f.root.key, "uncertain");
    f.ledger.quarantine(f.root.key);
    const next = {
        ...binding,
        bindingVersion: 2,
        revision: "r1",
        manifestHash: (await scan(f.root, defaults)).manifestHash,
      },
      rebind = new LocalWorkspace(f.root, next, f.profile, f.ledger, staging);
    await assert.rejects(rebind.importBinding(rebind.importProposal("new_version")), /quarantined/);
  } finally {
    await f.cleanup();
  }
});
test("native workspace apply never spawns, external drift and interrupted apply quarantine root", async () => {
  const f = await setup();
  try {
    const a = await assignment("never"),
      request = prepare(a, f.initial.manifestHash),
      prepared = await f.local.request(request);
    if (!("preparationId" in prepared)) throw new Error("prepared missing");
    const result = await f.local.request({
      ...requestScope(request),
      kind: "apply",
      preparationId: prepared.preparationId,
    });
    assert.ok("state" in result);
    assert.equal(result.state, "prepared");
    assert.equal(f.ledger.get(a.identity.jobId), undefined);
    await writeFile(join(f.rootPath, "outside-edit"), "unexpected");
    const observed = await f.local.request({
      ...requestScope(request),
      kind: "observe",
      preparationId: prepared.preparationId,
    });
    assert.ok("state" in observed);
    assert.equal(observed.state, "drift");
    assert.equal(f.ledger.rootAvailable(f.root.key, request.operationId), false);
  } finally {
    await f.cleanup();
  }
  const partial = await setup();
  try {
    const request = await staged(partial),
      prepared = await partial.local.request(request);
    if (!("preparationId" in prepared)) throw new Error("prepared missing");
    // Fault at actual filesystem write, after the durable apply claim.
    const original = partial.root.write.bind(partial.root);
    partial.root.write = async () => {
      throw new Error("synthetic disk full");
    };
    const result = await partial.local.request({
      ...requestScope(request),
      kind: "apply",
      preparationId: prepared.preparationId,
    });
    assert.ok("state" in result);
    assert.equal(result.state, "partial");
    partial.root.write = original;
    assert.deepEqual(
      await partial.local.request({
        ...requestScope(request),
        kind: "apply",
        preparationId: prepared.preparationId,
      }),
      result,
    );
    assert.equal(partial.ledger.rootAvailable(partial.root.key, request.operationId), false);
    await assert.rejects(readFile(join(partial.rootPath, "alpha")), { code: "ENOENT" });
  } finally {
    await partial.cleanup();
  }
});
test("full manifest binds revision reads; excluded bytes and historical mismatch never become current content", async () => {
  const f = await setup();
  try {
    await writeFile(join(f.rootPath, ".env.synthetic"), "synthetic-secret");
    assert.equal((await scan(f.root, defaults)).manifestHash, f.initial.manifestHash);
    const a = await assignment("never"),
      scope = {
        operationId: a.identity.lease.operationId,
        workspaceId: "workspace",
        bindingVersion: 1,
        rootBindingId: "root",
        executorId: "executor",
        executorGeneration: 7,
        credential,
        revision: "missing-history",
        deadline: Date.now() + 10000,
      };
    await assert.rejects(f.local.request({ ...scope, kind: "snapshot" }), /revision_unavailable/);
    await writeFile(join(f.rootPath, "unexpected"), "drift");
    await assert.rejects(
      f.local.request({ ...scope, kind: "snapshot", revision: "r0" }),
      /local_drift/,
    );
  } finally {
    await f.cleanup();
  }
});
test("ordered put then directory deletion/recreation applies actual mutations once using the public stage digest", async () => {
  const f = await fixture();
  try {
    await f.root.mkdir("tree");
    await f.root.write("tree/existing", Buffer.from("before"), 420);
    const initial = await scan(f.root, defaults),
      binding = f.profile.bindings[0];
    if (!binding) throw new Error("binding missing");
    binding.manifestHash = initial.manifestHash;
    const staging = new Staging(
      join(f.directory, "staging"),
      f.ledger,
      new HttpTransport(f.profile, fetch, true),
    );
    await staging.initialize();
    const local = new LocalWorkspace(f.root, binding, f.profile, f.ledger, staging);
    await importRoot(local);
    const a = await assignment("never executed"),
      request = prepare(a, initial.manifestHash),
      bytes = Buffer.from("intermediate old file"),
      sha256 = hash(bytes),
      manifest: Manifest = {
        version: 1,
        entries: [{ path: "tree", type: "directory", mode: 493 }],
      },
      uploadId = randomUUID();
    const mutations = [
        { kind: "put" as const, path: "tree/old", sha256, size: bytes.length, mode: 420 as const },
        { kind: "delete" as const, path: "tree" },
        { kind: "mkdir" as const, path: "tree", mode: 493 as const },
      ],
      postManifestHash = await manifestDigest(manifest),
      relay = await relayFixture(bytes),
      oldOrigin = f.profile.origin;
    f.profile.origin = relay.origin;
    try {
      await staging.receive({
        transferId: randomUUID(),
        attemptId: randomUUID(),
        deploymentId: f.profile.deploymentId,
        direction: "to-executor",
        purpose: "local-stage",
        workspaceId: "workspace",
        bindingVersion: 1,
        operationId: request.operationId,
        operationDigest: request.operationDigest,
        jobId: a.identity.jobId,
        executionId: a.identity.executionId,
        executorId: f.profile.executorId,
        executorGeneration: f.profile.executorGeneration,
        credential: request.credential,
        consumer: f.profile.resources,
        baseRevision: "r0",
        lease: request.lease,
        content: {
          kind: "workspace-file",
          path: "tree/old",
          manifestHash: postManifestHash,
          uploadId,
        },
        fileSha256: sha256,
        size: bytes.length,
        chunkBytes: bytes.length,
        chunkHashes: [sha256],
        expiresAt: Date.now() + 10000,
        deadline: request.deadline,
      });
    } finally {
      f.profile.origin = oldOrigin;
      await relay.close();
    }
    const prepareRequest: LocalPrepare = {
      ...request,
      mode: {
        kind: "staged-change",
        uploadId,
        manifest,
        mutations,
        postManifestHash,
        stagedDigest: await localStageDigest({ uploadId, manifest, mutations }),
      },
    };
    const prepared = await local.request(prepareRequest);
    assert.ok("preparationId" in prepared);
    const apply = {
      ...requestScope(prepareRequest),
      kind: "apply" as const,
      preparationId: prepared.preparationId,
    };
    const result = await local.request(apply);
    assert.ok("state" in result);
    assert.equal(result.state, "applied");
    assert.deepEqual(await f.root.entries("tree"), []);
    assert.equal(f.ledger.get(a.identity.jobId), undefined);
    assert.equal(
      f.ledger.local(request.operationId)?.journal.filter((j) => j.path === "tree/old").length,
      2,
      "ordered intermediate put and deletion must both be journaled",
    );
    assert.deepEqual(await local.request(apply), result);
  } finally {
    await f.cleanup();
  }
});
test("a stored preparation cannot be revived after expiry; observational closure releases only an unstarted pin", async () => {
  const f = await setup();
  try {
    const request = await staged(f),
      prepared = await f.local.request(request);
    assert.ok("preparationId" in prepared);
    const row = f.ledger.local(request.operationId);
    if (!row) throw new Error("local row missing");
    row.prepared.expiresAt = 0;
    f.ledger.saveLocal(row);
    const apply = {
      ...requestScope(request),
      kind: "apply" as const,
      preparationId: prepared.preparationId,
    };
    await assert.rejects(f.local.request(apply), /expired_lease/);
    await f.local.expirePrepared();
    assert.equal(f.ledger.rootAvailable(f.root.key), true);
    await assert.rejects(f.local.request(apply), /expired_lease/);
    await assert.rejects(readFile(join(f.rootPath, "alpha")), { code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});
test("cloud snapshot bytes materialize and a lost upload acknowledgment retries only the same staged identity", async () => {
  const f = await fixture(),
    original = Buffer.from("immutable original bytes"),
    originalSha = hash(original),
    manifest: Manifest = {
      version: 1,
      entries: [
        { path: "file", type: "file", mode: 420, size: original.length, sha256: originalSha },
      ],
    },
    baseHash = await manifestDigest(manifest),
    server = await snapshotFixture(manifest, baseHash, new Map([[originalSha, original]]));
  try {
    f.profile.origin = server.origin;
    const http = new HttpTransport(f.profile, fetch, true),
      snapshots = new Snapshots(join(f.directory, "scratch"), f.ledger, http, adapter()),
      a = await assignment("never spawned"),
      root = await snapshots.materialize(a);
    assert.equal((await root.read("file", 100)).toString(), "immutable original bytes");
    const changed = Buffer.alloc(600000, 0x61);
    await root.write("file", changed, 420);
    await root.write("empty", Buffer.alloc(0), 420);
    const requestId = randomUUID(),
      commitId = randomUUID();
    await assert.rejects(snapshots.stage(a, root, requestId, commitId));
    const intent = f.ledger.record<{ requestId: string; commitId: string }>(
      "stages",
      `upload_intent_${a.identity.executionId}`,
    );
    assert.equal(intent?.requestId, requestId);
    assert.equal(intent?.commitId, commitId);
    const result = await snapshots.stage(a, root, randomUUID(), randomUUID());
    assert.equal(result.uploadId, "server_upload");
    assert.equal(result.commitId, commitId);
    assert.equal(result.stageId, "public_stage");
    assert.deepEqual(server.begins[0], server.begins[1]);
    assert.equal(
      server.requests.some((r) => r.endsWith("/commit")),
      false,
    );
    assert.equal(
      server.requests.filter((r) => r.includes(`/blobs/${hash(Buffer.alloc(0))}/chunks/`)).length,
      0,
      "zero bytes need no public PUT",
    );
    assert.equal(original.toString(), "immutable original bytes");
    assert.equal(
      f.ledger.get(a.identity.jobId),
      undefined,
      "snapshot/staging cannot create a native execution",
    );
    await assert.rejects(snapshots.cleanup(a, result.manifestHash), /terminal evidence/);
    await assert.rejects(
      snapshots.stage(
        { ...a, identity: { ...a.identity, lease: { ...a.identity.lease, expiresAt: 0 } } },
        root,
        requestId,
        commitId,
      ),
      /expired/,
    );
    assert.equal(original.toString(), "immutable original bytes");
  } finally {
    await server.close();
    await f.cleanup();
  }
});
