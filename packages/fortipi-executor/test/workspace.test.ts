import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type {
  CommitReceipt,
  ExecutorFrame,
  LocalObservation,
  LocalPrepare,
  LocalReadRequest,
  TransferDescriptor,
} from "fortipi-contract/executor";
import {
  commitDigest,
  localStageDigest,
  manifestDigest,
  validateUploadBlobs,
  workspaceLeaseDigest,
} from "fortipi-contract/executor";
import { adapter, defaults } from "../dist/config.js";
import { ExecutorRuntime } from "../dist/daemon.js";
import { hash } from "../dist/policy.js";
import { HttpTransport } from "../dist/transport.js";
import { LocalWorkspace } from "../dist/workspace/local.js";
import type { Manifest } from "../dist/workspace/manifest.js";
import { scan } from "../dist/workspace/manifest.js";
import { Snapshots } from "../dist/workspace/snapshot.js";
import { Staging } from "../dist/workspace/staging.js";
import {
  assignment,
  authenticateFixture,
  credential,
  fixture,
  importRoot,
  jobRenewals,
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
async function staged(
  f: Awaited<ReturnType<typeof setup>>,
  name = "alpha",
  content = "expected committed content",
): Promise<LocalPrepare> {
  const a = await assignment("not executed", undefined, f.local.binding.revision),
    base = prepare(a, f.local.binding.manifestHash),
    bytes = Buffer.from(content),
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
    baseRevision: base.baseRevision,
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
  revision = "r1",
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
    revision,
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
    // The CP authenticates a new reader separately; the wire journal identity stays historical.
    const nextCaller = { ...request.credential, generation: request.credential.generation + 1 };
    await assert.rejects(
      f.local.request({
        ...requestScope(expired),
        kind: "observe",
        preparationId,
        credential: nextCaller,
        lease: { ...expired.lease, credential: nextCaller },
      }),
      /scope conflict/,
    );
    await assert.rejects(
      f.local.request({
        ...requestScope(expired),
        kind: "observe",
        preparationId,
        executorGeneration: request.executorGeneration + 1,
      }),
      /authority mismatch/,
    );
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
    await assert.rejects(
      f.local.request({
        ...receiptScope(expired),
        kind: "receipt",
        preparationId,
        receipt: { ...proof, commitDigest: "0".repeat(64) },
      }),
      /digest mismatch/,
    );
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
    const next = await staged(f, "alpha", "next committed bytes"),
      nextPrepared = await f.local.request(next);
    if (!("preparationId" in nextPrepared)) throw new Error("next preparation absent");
    const nextApplied = (await f.local.request({
      ...requestScope(next),
      kind: "apply",
      preparationId: nextPrepared.preparationId,
    })) as LocalObservation;
    const nextReceipt = await receipt(next, nextApplied, "r2");
    await f.local.request({
      ...receiptScope(next),
      kind: "receipt",
      preparationId: nextPrepared.preparationId,
      receipt: nextReceipt,
    });
    const history = await f.local.request({
      ...requestScope(expired),
      kind: "observe",
      preparationId,
    });
    assert.ok("state" in history && history.state === "applied");
    assert.ok("receipt" in history && history.receipt?.commitDigest === proof.commitDigest);
    assert.equal(f.local.binding.revision, "r2");
    assert.equal(
      f.ledger.rootAvailable(f.root.key),
      true,
      "historical observation must not quarantine a later valid revision",
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
  let renewals: ReturnType<typeof jobRenewals> | undefined;
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
    authenticateFixture(staging.http);
    const runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http: staging.http,
    });
    renewals = jobRenewals(runtime, a);
    await renewals.renew();
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
      lease: f.ledger.existing(a.identity)?.assignment.identity.lease ?? request.lease,
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
    await renewals.renew();
    const apply = {
      ...requestScope(prepareRequest),
      lease: f.ledger.local(request.operationId)?.request.lease ?? prepareRequest.lease,
      kind: "apply" as const,
      preparationId: prepared.preparationId,
    };
    const result = await local.request(apply);
    assert.ok("state" in result);
    assert.equal(
      result.state,
      "applied",
      JSON.stringify({
        reason: "reason" in result ? result.reason : undefined,
        journal: f.ledger.local(request.operationId)?.journal,
        remainingLeaseMs:
          (f.ledger.local(request.operationId)?.request.lease.expiresAt ?? 0) - Date.now(),
      }),
    );
    assert.deepEqual(await f.root.entries("tree"), []);
    assert.equal(f.ledger.get(a.identity.jobId)?.state, "pending");
    assert.equal(runtime.children.size, 0, "workspace apply never spawns native execution");
    assert.ok((f.ledger.local(request.operationId)?.request.lease.leaseVersion ?? 0) > 1);
    assert.equal(
      f.ledger.local(request.operationId)?.journal.filter((j) => j.path === "tree/old").length,
      2,
      "ordered intermediate put and deletion must both be journaled",
    );
    await renewals.renew();
    assert.deepEqual(
      await local.request({
        ...apply,
        lease: f.ledger.local(request.operationId)?.request.lease ?? apply.lease,
      }),
      result,
    );
  } finally {
    try {
      await renewals?.stop();
    } finally {
      await f.cleanup();
    }
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
  let renewals: ReturnType<typeof jobRenewals> | undefined;
  try {
    f.profile.origin = server.origin;
    const http = new HttpTransport(f.profile, fetch, true),
      snapshots = new Snapshots(join(f.directory, "scratch"), f.ledger, http, adapter()),
      a = await assignment("never spawned");
    authenticateFixture(http);
    const runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http,
    });
    renewals = jobRenewals(runtime, a);
    await renewals.renew();
    const root = await snapshots.materialize(a);
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
    assert.equal(runtime.children.size, 0, "snapshot/staging cannot spawn a native execution");
    await assert.rejects(snapshots.cleanup(a, result.manifestHash), /terminal evidence/);
    await renewals.stop();
    renewals = undefined;
    const expired = f.ledger.existing(a.identity);
    if (!expired) throw new Error("attempt absent");
    expired.assignment.identity.lease.expiresAt = 0;
    f.ledger.put(expired);
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
    try {
      await renewals?.stop();
    } finally {
      await server.close();
      await f.cleanup();
    }
  }
});
test("two-phase local read returns real negotiated-grid inventory and concurrent body-bound retries produce bytes once", async () => {
  const f = await fixture(),
    bytes = Buffer.alloc(600000, 0x5a),
    digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex"),
    relay = await relayFixture(bytes);
  try {
    await f.root.write("large.bin", bytes, 420);
    const actual = await scan(f.root, defaults),
      binding = f.profile.bindings[0];
    if (!binding) throw new Error("binding missing");
    binding.manifestHash = actual.manifestHash;
    f.profile.origin = relay.origin;
    f.profile.limits.chunkBytes = 65536;
    const http = new HttpTransport(f.profile, fetch, true);
    authenticateFixture(http);
    const runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http,
    });
    await runtime.initialize();
    const local = runtime.locals.get("root");
    if (!local) throw new Error("local missing");
    await importRoot(local);
    relay.setGrid(http.chunkBytes);
    const scope: Extract<LocalReadRequest, { kind: "read" }> = {
      kind: "read",
      operationId: "read_large",
      workspaceId: "workspace",
      bindingVersion: 1,
      rootBindingId: "root",
      executorId: f.profile.executorId,
      executorGeneration: f.profile.executorGeneration,
      credential,
      revision: "r0",
      deadline: Date.now() + 60000,
      path: "large.bin",
    };
    const metadata: Extract<ExecutorFrame, { type: "workspace.request" }> = {
      type: "workspace.request",
      requestId: "outer_metadata",
      payload: { requestId: "metadata", correlationId: "metadata_corr", request: scope },
    };
    const [m, duplicate] = await Promise.all([
      runtime.handleWorkspaceFrame(metadata),
      runtime.handleWorkspaceFrame(metadata),
    ]);
    assert.deepEqual(m, duplicate);
    const response = m.payload.response;
    assert.ok("kind" in response && response.kind === "read");
    const reference = response.result;
    assert.equal(reference.sha256, digest(bytes));
    assert.equal(reference.size, bytes.length);
    assert.ok(reference.chunks);
    assert.equal(reference.chunks.chunkBytes, 65536);
    assert.deepEqual(
      reference.chunks.chunkHashes,
      Array.from({ length: Math.ceil(bytes.length / 65536) }, (_, i) =>
        digest(bytes.subarray(i * 65536, (i + 1) * 65536)),
      ),
    );
    assert.equal(relay.requests.length, 0, "metadata phase must not start a producer");
    const descriptor: TransferDescriptor = {
      transferId: "read_transfer",
      attemptId: "read_attempt",
      deploymentId: f.profile.deploymentId,
      direction: "from-executor",
      purpose: "local-read",
      workspaceId: "workspace",
      bindingVersion: 1,
      operationId: scope.operationId,
      operationDigest: "a".repeat(64),
      executorId: f.profile.executorId,
      executorGeneration: f.profile.executorGeneration,
      credential,
      consumer: f.profile.resources,
      baseRevision: "r0",
      content: { kind: "workspace-file", path: scope.path, manifestHash: actual.manifestHash },
      fileSha256: reference.sha256,
      size: reference.size,
      chunkBytes: reference.chunks.chunkBytes,
      chunkHashes: reference.chunks.chunkHashes,
      expiresAt: Date.now() + 20000,
      deadline: scope.deadline,
    };
    const producer: Extract<ExecutorFrame, { type: "workspace.request" }> = {
      type: "workspace.request",
      requestId: "outer_producer",
      payload: {
        requestId: "producer",
        correlationId: "producer_corr",
        request: { ...scope, transfers: [descriptor] },
      },
    };
    await assert.rejects(
      runtime.handleWorkspaceFrame({
        ...metadata,
        payload: { ...metadata.payload, request: producer.payload.request },
      }),
      /body conflict/,
    );
    assert.equal(relay.requests.length, 0);
    const invalid = await runtime.handleWorkspaceFrame({
      ...producer,
      requestId: "outer_bad_generation",
      payload: {
        ...producer.payload,
        requestId: "bad_generation",
        correlationId: "bad_generation_corr",
        request: { ...scope, transfers: [{ ...descriptor, executorGeneration: 8 }] },
      },
    });
    assert.ok("error" in invalid.payload.response);
    assert.equal(relay.requests.length, 0);
    const [produced, repeated] = await Promise.all([
      runtime.handleWorkspaceFrame(producer),
      runtime.handleWorkspaceFrame(producer),
    ]);
    assert.deepEqual(produced, repeated);
    assert.equal(relay.requests.length, reference.chunks.chunkHashes.length);
    assert.deepEqual(Buffer.concat(relay.requests.map((r) => r.bytes)), bytes);
    await runtime.handleWorkspaceFrame(producer);
    assert.equal(
      relay.requests.length,
      reference.chunks.chunkHashes.length,
      "completed producer retry is observational",
    );
    http.jsonBytes = 256;
    await assert.rejects(
      runtime.handleWorkspaceFrame({
        ...producer,
        requestId: "oversize",
        payload: { ...producer.payload, requestId: "oversize", correlationId: "oversize_corr" },
      }),
      /payload_too_large/,
    );
    assert.equal(
      f.ledger.db.prepare("SELECT value FROM meta WHERE key='workspace_request_oversize'").get(),
      undefined,
    );
  } finally {
    await relay.close();
    await f.cleanup();
  }
});
test("exact metadata renewal reaches an active apply before expiry without losing its durable filesystem journal", async () => {
  const f = await setup(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    mkdir = f.root.mkdir.bind(f.root);
  let applying: Promise<unknown> | undefined;
  try {
    const base = prepare(await assignment("never executed"), f.initial.manifestHash);
    if (base.lease.ownerKind !== "job") throw new Error("fixture job missing");
    const { jobId: _job, ownerKind: _kind, ...identity } = base.lease;
    const lease = {
        ...identity,
        ownerKind: "workspace-operation" as const,
        expiresAt: Date.now() + 10000,
      },
      manifest: Manifest = {
        version: 1,
        entries: [
          { path: "a", type: "directory", mode: 493 },
          { path: "b", type: "directory", mode: 493 },
        ],
      },
      mutations = [
        { kind: "mkdir" as const, path: "a", mode: 493 as const },
        { kind: "mkdir" as const, path: "b", mode: 493 as const },
      ],
      uploadId = "active_renewal_stage";
    const request: LocalPrepare = {
      ...base,
      lease,
      operationDigest: await workspaceLeaseDigest({
        deploymentId: f.profile.deploymentId,
        operationId: base.operationId,
        workspaceId: base.workspaceId,
        bindingVersion: base.bindingVersion,
        baseRevision: base.baseRevision,
        target: {
          kind: "executor",
          executorId: base.executorId,
          generation: base.executorGeneration,
        },
        credential: base.credential,
        deadline: base.deadline,
      }),
      mode: {
        kind: "staged-change",
        uploadId,
        manifest,
        mutations,
        postManifestHash: await manifestDigest(manifest),
        stagedDigest: await localStageDigest({ uploadId, manifest, mutations }),
      },
    };
    const prepared = await f.local.request(request);
    if (!("preparationId" in prepared)) throw new Error("preparation absent");
    f.root.mkdir = async (path) => {
      await mkdir(path);
      if (path === "a") {
        entered.resolve();
        await release.promise;
      }
    };
    applying = f.local.request({
      ...requestScope(request),
      kind: "apply",
      preparationId: prepared.preparationId,
    });
    await Promise.race([
      entered.promise,
      applying.then(() => {
        throw new Error("apply ended before the first filesystem barrier");
      }),
    ]);
    const renewed = {
      ...request,
      lease: {
        ...lease,
        leaseVersion: lease.leaseVersion + 1,
        expiresAt: Math.min(request.deadline, Date.now() + 30000),
      },
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const ack = await Promise.race([
      f.local.request(renewed),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("active metadata renewal blocked behind filesystem apply")),
          5000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.ok(
      "preparationId" in ack &&
        "expiresAt" in ack &&
        ack.preparationId === prepared.preparationId &&
        ack.expiresAt === renewed.lease.expiresAt,
    );
    if (renewed.mode.kind !== "staged-change") throw new Error("staged renewal missing");
    await assert.rejects(
      f.local.request({ ...renewed, mode: { ...renewed.mode, postManifestHash: "0".repeat(64) } }),
      /conflict/,
    );
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, lease.expiresAt - Date.now() + 20)),
    );
    release.resolve();
    const result = await applying;
    assert.ok(
      typeof result === "object" &&
        result !== null &&
        "state" in result &&
        result.state === "applied",
    );
    assert.deepEqual(await f.root.entries(), ["a", "b"]);
    const row = f.ledger.local(request.operationId);
    assert.deepEqual(row?.journal, [
      { path: "a", state: "done" },
      { path: "b", state: "done" },
    ]);
    assert.equal(row?.request.lease.leaseVersion, renewed.lease.leaseVersion);
    assert.equal(row?.request.lease.expiresAt, renewed.lease.expiresAt);
    assert.equal(
      f.ledger.rootAvailable(f.root.key),
      false,
      "renewal and apply remain separate from receipt commit",
    );
  } finally {
    release.resolve();
    await applying?.catch(() => {});
    f.root.mkdir = mkdir;
    await f.cleanup();
  }
});
test("revoking executor authority between actual filesystem effects stops an active local apply", async () => {
  const f = await setup(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    mkdir = f.root.mkdir.bind(f.root);
  let applying: Promise<unknown> | undefined;
  try {
    const base = prepare(await assignment("never executed"), f.initial.manifestHash),
      manifest: Manifest = {
        version: 1,
        entries: [
          { path: "a", type: "directory", mode: 493 },
          { path: "b", type: "directory", mode: 493 },
        ],
      },
      mutations = [
        { kind: "mkdir" as const, path: "a", mode: 493 as const },
        { kind: "mkdir" as const, path: "b", mode: 493 as const },
      ],
      uploadId = "revocation_stage",
      request: LocalPrepare = {
        ...base,
        mode: {
          kind: "staged-change",
          uploadId,
          manifest,
          mutations,
          postManifestHash: await manifestDigest(manifest),
          stagedDigest: await localStageDigest({ uploadId, manifest, mutations }),
        },
      };
    authenticateFixture(f.staging.http);
    const runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http: f.staging.http,
    });
    const prepared = await f.local.request(request);
    if (!("preparationId" in prepared)) throw new Error("preparation absent");
    f.root.mkdir = async (path) => {
      await mkdir(path);
      if (path === "a") {
        entered.resolve();
        await release.promise;
      }
    };
    applying = f.local.request({
      ...requestScope(request),
      kind: "apply",
      preparationId: prepared.preparationId,
    });
    await Promise.race([
      entered.promise,
      applying.then(() => {
        throw new Error("apply ended before the first filesystem effect");
      }),
    ]);
    await runtime.receive({
      type: "executor.presence",
      requestId: "revoke_at_filesystem_barrier",
      payload: {
        executorId: f.profile.executorId,
        generation: f.profile.executorGeneration,
        connectionEpoch: 1,
        platform: adapter().platform,
        caseBehavior: f.root.identity.caseBehavior,
        confinement: "host",
        rootBindingIds: ["root"],
        state: "revoking",
        capabilities: ["local-workspace"],
        transferLimits: f.staging.http.transferLimits(),
      },
    });
    release.resolve();
    const result = await applying;
    assert.ok(typeof result === "object" && result !== null && "state" in result);
    assert.equal(result.state, "partial", "revocation must stop the second filesystem effect");
    assert.deepEqual(await f.root.entries(), ["a"]);
    assert.deepEqual(f.ledger.local(request.operationId)?.journal, [{ path: "a", state: "done" }]);
    assert.equal(f.ledger.rootAvailable(f.root.key), false);
    assert.equal(f.ledger.local(request.operationId)?.observation.receipt, undefined);
  } finally {
    release.resolve();
    await applying?.catch(() => {});
    f.root.mkdir = mkdir;
    await f.cleanup();
  }
});
test("multi-chunk local stage verifies scoped bytes, shares one SHA only inside its upload, and applies empty files without PUT", async () => {
  const f = await setup(),
    bytes = Buffer.alloc(600000, 0x31),
    sha256 = createHash("sha256").update(bytes).digest("hex"),
    emptySha = createHash("sha256").digest("hex"),
    grid = 16384,
    relay = await relayFixture(bytes);
  let renewals: ReturnType<typeof jobRenewals> | undefined;
  try {
    const a = await assignment("never executed"),
      base = prepare(a, f.initial.manifestHash),
      uploadId = "chunked_upload",
      manifest: Manifest = {
        version: 1,
        entries: [
          { path: "one", type: "file", mode: 420, size: bytes.length, sha256 },
          { path: "two", type: "file", mode: 420, size: bytes.length, sha256 },
          { path: "empty", type: "file", mode: 420, size: 0, sha256: emptySha },
        ],
      },
      postManifestHash = await manifestDigest(manifest),
      mutations = manifest.entries.map((e) => {
        if (e.type !== "file") throw new Error("file expected");
        return { kind: "put" as const, path: e.path, sha256: e.sha256, size: e.size, mode: e.mode };
      }),
      chunks = {
        chunkBytes: grid,
        chunkHashes: Array.from({ length: Math.ceil(bytes.length / grid) }, (_, i) =>
          createHash("sha256")
            .update(bytes.subarray(i * grid, (i + 1) * grid))
            .digest("hex"),
        ),
      };
    const begin: Parameters<typeof validateUploadBlobs>[0] = {
      requestId: "begin",
      baseRevision: base.baseRevision,
      lease: base.lease,
      operationId: base.operationId,
      commitId: base.commitId,
      manifestHash: postManifestHash,
      manifest,
      mutations,
      blobs: [
        { sha256, chunks },
        { sha256: emptySha, chunks: { chunkBytes: grid, chunkHashes: [] } },
      ],
    };
    validateUploadBlobs(begin, { required: true });
    assert.throws(
      () => validateUploadBlobs({ ...begin, blobs: [] }, { required: true }),
      /missing_blobs/,
    );
    authenticateFixture(f.staging.http);
    const runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http: f.staging.http,
    });
    renewals = jobRenewals(runtime, a);
    await renewals.renew();
    const currentLease = () => {
      const lease = f.ledger.existing(a.identity)?.assignment.identity.lease;
      if (!lease) throw new Error("renewed job lease missing");
      assert.ok(Date.now() < lease.expiresAt, "challenge needs a live actual lease observation");
      assert.ok(Date.now() < base.deadline, "challenge needs the unchanged admission deadline");
      return lease;
    };
    const descriptor: TransferDescriptor = {
      transferId: "input",
      attemptId: "input_attempt",
      deploymentId: f.profile.deploymentId,
      direction: "to-executor",
      purpose: "local-stage",
      workspaceId: "workspace",
      bindingVersion: 1,
      operationId: base.operationId,
      operationDigest: base.operationDigest,
      jobId: a.identity.jobId,
      executionId: a.identity.executionId,
      executorId: f.profile.executorId,
      executorGeneration: f.profile.executorGeneration,
      credential,
      consumer: f.profile.resources,
      baseRevision: "r0",
      lease: base.lease,
      content: { kind: "workspace-file", path: "one", manifestHash: postManifestHash, uploadId },
      fileSha256: sha256,
      size: bytes.length,
      chunkBytes: grid,
      chunkHashes: chunks.chunkHashes,
      expiresAt: Date.now() + 20000,
      deadline: base.deadline,
    };
    const oldOrigin = f.profile.origin;
    f.profile.origin = relay.origin;
    relay.setGrid(grid);
    try {
      await f.staging.receive(descriptor);
      await f.staging.receive({
        ...descriptor,
        transferId: "empty_input",
        content: { ...descriptor.content, path: "empty" },
        fileSha256: emptySha,
        size: 0,
        chunkHashes: [],
      });
    } finally {
      f.profile.origin = oldOrigin;
    }
    assert.equal(
      relay.requests.length,
      chunks.chunkHashes.length,
      "one verified upload SHA covers both declared paths; zero file transfers no chunks",
    );
    const beforeChangedGrid = relay.requests.length,
      changedGrid = 32768,
      changedHashes = Array.from({ length: Math.ceil(bytes.length / changedGrid) }, (_, i) =>
        createHash("sha256")
          .update(bytes.subarray(i * changedGrid, (i + 1) * changedGrid))
          .digest("hex"),
      );
    await assert.rejects(
      f.staging.receive({
        ...descriptor,
        transferId: "changed_grid",
        attemptId: "changed_grid_attempt",
        chunkBytes: changedGrid,
        chunkHashes: changedHashes,
      }),
      /immutable record conflict/,
    );
    assert.equal(
      relay.requests.length,
      beforeChangedGrid,
      "announced grid cannot silently change before bytes",
    );
    const mode = {
        kind: "staged-change" as const,
        uploadId,
        manifest,
        mutations,
        postManifestHash,
        stagedDigest: await localStageDigest({ uploadId, manifest, mutations }),
      },
      request: LocalPrepare = { ...base, lease: currentLease(), mode };
    const badMode = {
      ...mode,
      uploadId: "foreign_upload",
      stagedDigest: await localStageDigest({ ...mode, uploadId: "foreign_upload" }),
    };
    await assert.rejects(
      f.local.request({ ...base, lease: currentLease(), mode: badMode }),
      /upload-scoped/,
    );
    assert.equal((await scan(f.root, defaults)).manifestHash, f.initial.manifestHash);
    const prepared = await f.local.request(request);
    assert.ok("preparationId" in prepared);
    const apply = {
        ...requestScope(request),
        lease: currentLease(),
        kind: "apply" as const,
        preparationId: prepared.preparationId,
      },
      result = await f.local.request(apply);
    assert.ok("state" in result);
    assert.equal(result.state, "applied");
    assert.deepEqual(await f.root.read("one", defaults.fileBytes), bytes);
    assert.deepEqual(await f.root.read("two", defaults.fileBytes), bytes);
    assert.equal((await f.root.read("empty", defaults.fileBytes)).length, 0);
    assert.equal(f.ledger.get(a.identity.jobId)?.state, "pending");
    assert.equal(runtime.children.size, 0, "renewal fixture cannot execute the job");
    await renewals.renew();
    const liveLease = currentLease();
    assert.equal(liveLease.fence, "1");
    await assert.rejects(
      f.local.request({
        ...request,
        operationId: "higher_fence",
        lease: { ...liveLease, operationId: "higher_fence", fence: "2" },
      }),
      /root pinned or quarantined/,
    );
    assert.equal(
      (
        f.ledger.db.prepare("SELECT value FROM meta WHERE key='fence_root_1'").get() as {
          value: string;
        }
      ).value,
      "2",
      "higher authoritative fence must be durable before challenging the old fence",
    );
    await assert.rejects(f.local.request({ ...apply, lease: currentLease() }), /stale_fence/);
    const observed = await f.local.request({
      ...requestScope(request),
      kind: "observe",
      preparationId: prepared.preparationId,
    });
    assert.ok("state" in observed);
    assert.equal(observed.state, "applied");
    assert.deepEqual(await f.root.read("one", defaults.fileBytes), bytes);
  } finally {
    try {
      await renewals?.stop();
    } finally {
      await relay.close();
      await f.cleanup();
    }
  }
});
