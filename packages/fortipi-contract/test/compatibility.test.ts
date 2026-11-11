import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertUtf8Bytes,
  canonicalJson,
  commitDigest,
  digestJson,
  knownEventTypes,
  localIntentDigest,
  localStageDigest,
  manifestDigest,
  nextEventCursor,
  operationForAssignment,
  validateAssignment,
  validateLocalLease,
  validateLocalStage,
  workspaceLeaseDigest,
} from "../dist/index.js";
import {
  completeAssignment,
  completeLocalStage,
  eventBase,
  hash,
  lease,
  messageEvent,
  observation,
  scope,
  unknownDurable,
  validators,
} from "./fixtures/wire.ts";

const { get } = validators();
test("received assignments reconstruct the explicit v1 preimage and validate both digests", async () => {
  const { assignment, operation } = await completeAssignment();
  const validate = get("Assignment");
  assert.equal(
    get("OperationContext")({
      ...assignment.operationContext,
      policyVersion: Number.MAX_SAFE_INTEGER,
    }),
    true,
  );
  for (const policyVersion of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(
      validate({
        ...assignment,
        operationContext: { ...assignment.operationContext, policyVersion },
      }),
      false,
    );
  assert.equal(validate(assignment), true, JSON.stringify(validate.errors));
  assert.deepEqual(operationForAssignment(assignment), operation);
  const canonicalOperation =
    '{"agentId":"agent_1","arguments":{"argv":["echo","hello"]},"baseRevision":"revision_1","conversationId":"conversation_1","deadline":50000,"deploymentId":"deployment_1","grantVersion":3,"policyVersion":5,"target":{"executorId":"executor_1","generation":4,"kind":"executor"},"tool":"shell.exec","workspaceId":"workspace_1"}';
  const canonicalAssignment =
    '{"executionId":"execution_1","executorGeneration":4,"fence":"7","leaseId":"lease_1","operation":' +
    canonicalOperation +
    ',"reservationId":"reservation_1"}';
  assert.equal(
    assignment.identity.operationDigest,
    createHash("sha256").update(`fortipi:operation:v1\n${canonicalOperation}`).digest("hex"),
  );
  assert.equal(
    assignment.identity.assignmentDigest,
    createHash("sha256").update(`fortipi:assignment:v1\n${canonicalAssignment}`).digest("hex"),
  );
  await assert.doesNotReject(() => validateAssignment(assignment));
  // Each digest is independently required, even when all other identity/preimage fields match.
  await assert.rejects(
    validateAssignment({
      ...assignment,
      identity: { ...assignment.identity, operationDigest: "b".repeat(64) },
    }),
    /operation_digest/,
  );
  await assert.rejects(
    validateAssignment({
      ...assignment,
      identity: { ...assignment.identity, assignmentDigest: "b".repeat(64) },
    }),
    /assignment_digest/,
  );
  for (const changed of [
    { ...assignment, arguments: { argv: ["echo", "changed"] } },
    ...["deploymentId", "agentId", "conversationId"].map((field) => ({
      ...assignment,
      operationContext: { ...assignment.operationContext, [field]: "changed" },
    })),
    { ...assignment, operationContext: { ...assignment.operationContext, policyVersion: 6 } },
    {
      ...assignment,
      identity: {
        ...assignment.identity,
        lease: { ...lease, credential: { ...lease.credential, grantVersion: 4 } },
      },
    },
  ])
    await assert.rejects(validateAssignment(changed), /operation_digest/);
  for (const changed of [
    { ...assignment, identity: { ...assignment.identity, lease: { ...lease, fence: "8" } } },
    { ...assignment, reservationId: "reservation_2" },
    { ...assignment, identity: { ...assignment.identity, executionId: "execution_2" } },
    {
      ...assignment,
      identity: { ...assignment.identity, lease: { ...lease, leaseId: "lease_2" } },
    },
  ])
    await assert.rejects(validateAssignment(changed), /assignment_digest/);
  for (const changed of [
    { ...assignment, identity: { ...assignment.identity, jobId: "other_job" } },
    { ...assignment, workspaceId: "other_workspace" },
    { ...assignment, identity: { ...assignment.identity, baseRevision: "other_revision" } },
    {
      ...assignment,
      identity: {
        ...assignment.identity,
        target: { kind: "executor" as const, executorId: "other_executor", generation: 4 },
      },
    },
    {
      ...assignment,
      identity: {
        ...assignment.identity,
        target: { kind: "executor" as const, executorId: "executor_1", generation: 5 },
      },
    },
    {
      ...assignment,
      identity: {
        ...assignment.identity,
        target: { kind: "backend" as const, backendId: "backend_1", generation: 4 },
      },
    },
    {
      ...assignment,
      identity: {
        ...assignment.identity,
        lease: { ...lease, ownerKind: "workspace-operation" as const },
      },
    },
  ])
    await assert.rejects(validateAssignment(changed), /assignment.invalid: identity/);
  const generationChanged = {
    ...assignment,
    identity: {
      ...assignment.identity,
      target: { kind: "executor" as const, executorId: "executor_1", generation: 5 },
      lease: { ...lease, executorGeneration: 5 },
    },
  };
  await assert.rejects(validateAssignment(generationChanged), /operation_digest/);
  const renewed = {
    ...assignment,
    identity: { ...assignment.identity, lease: { ...lease, expiresAt: 40000, leaseVersion: 2 } },
  };
  assert.equal(validate(renewed), true);
  assert.deepEqual(operationForAssignment(renewed), operation);
  await assert.doesNotReject(() => validateAssignment(renewed));
  for (const field of ["deploymentId", "agentId", "conversationId", "policyVersion"]) {
    const incomplete = { ...assignment.operationContext };
    Reflect.deleteProperty(incomplete, field);
    assert.equal(validate({ ...assignment, operationContext: incomplete }), false);
  }
  assert.equal(validate({ ...assignment, operationContext: undefined }), false);
  for (const extra of [{ principalId: "principal_1" }, { arguments: {} }])
    assert.equal(
      validate({ ...assignment, operationContext: { ...assignment.operationContext, ...extra } }),
      false,
    );
  assert.equal(
    get("ExecutorFrame")({ type: "job.assign", requestId: "request_1", payload: assignment }),
    true,
  );
});
test("malformed known event cannot become an unknown extension", () => {
  const validate = get("ClientEvent");
  assert.equal(validate({ ...messageEvent, payload: {} }), false, "malformed-known exclusion");
  assert.equal(validate(messageEvent), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...messageEvent, eventSeq: 0 }), false);
  for (const type of knownEventTypes) {
    assert.equal(
      validate({ ...unknownDurable, type, payload: {} }),
      false,
      `malformed durable ${type}`,
    );
    assert.equal(
      validate({ ...eventBase, durability: "volatile", type, payload: {} }),
      false,
      `malformed volatile ${type}`,
    );
  }
  assert.equal(validate(unknownDurable), true);
  assert.equal(nextEventCursor(0, unknownDurable), 1);
  assert.equal(nextEventCursor(1, unknownDurable), 1);
  assert.throws(() => nextEventCursor(0, { ...unknownDurable, eventSeq: 2 }), /resync/);
});
test("commit identity survives lease renewal and changes with immutable authority", async () => {
  const input = {
    commitId: "commit_1",
    uploadId: "upload_1",
    operationId: lease.operationId,
    jobId: lease.jobId,
    workspaceId: lease.workspaceId,
    baseRevision: lease.baseRevision,
    manifestHash: hash,
    leaseIdentity: lease,
    storage: {
      kind: "local" as const,
      preparationId: "preparation_1",
      observationSeq: 1,
      preManifestHash: hash,
      postManifestHash: hash,
    },
  };
  const expected =
    '{"baseRevision":"revision_1","commitId":"commit_1","jobId":"job_1","leaseIdentity":{"baseRevision":"revision_1","credential":{"credentialId":"credential_1","generation":2,"grantVersion":3},"executorGeneration":4,"executorId":"executor_1","fence":"7","jobId":"job_1","leaseId":"lease_1","operationId":"operation_1","ownerKind":"job","registrationId":"registration_1","workspaceId":"workspace_1"},"manifestHash":"' +
    hash +
    '","operationId":"operation_1","storage":{"kind":"local","observationSeq":1,"postManifestHash":"' +
    hash +
    '","preManifestHash":"' +
    hash +
    '","preparationId":"preparation_1"},"uploadId":"upload_1","workspaceId":"workspace_1"}';
  const digest = await commitDigest(input);
  const { uploadId: _upload, ...nativeCommit } = input;
  assert.notEqual(
    await commitDigest(nativeCommit),
    digest,
    "Native local evidence needs no fictitious upload",
  );
  const renewedLease = { ...lease, expiresAt: 40000, leaseVersion: 2 };
  assert.equal(digest, createHash("sha256").update(`fortipi:commit:v1\n${expected}`).digest("hex"));
  assert.equal(
    digest,
    await commitDigest({
      ...input,
      leaseIdentity: renewedLease,
    }),
    "renewal is excluded from immutable identity",
  );
  for (const changed of [
    { ...input, leaseIdentity: { ...lease, fence: "8" } },
    { ...input, leaseIdentity: { ...lease, credential: { ...lease.credential, generation: 3 } } },
    { ...input, storage: { ...input.storage, observationSeq: 2 } },
  ])
    assert.notEqual(digest, await commitDigest(changed));
});
test("volatile deltas omit sequence and never advance durable cursor", () => {
  const delta = {
    ...eventBase,
    durability: "volatile" as const,
    type: "message.delta",
    payload: { messageId: "message_1", text: "x" },
  };
  assert.equal(get("ClientEvent")(delta), true);
  assert.equal(nextEventCursor(2, delta), 2);
  assert.equal(get("ClientEvent")({ ...delta, eventSeq: 3 }), false);
  assert.equal(
    get("ClientEvent")({ ...delta, type: "future.progress", payload: { anything: true } }),
    true,
  );
  assert.equal(get("ClientEvent")({ ...unknownDurable, type: "message.delta" }), false);
});
test("canonical identity has independent byte/hash oracle and rejects non-JSON", async () => {
  assert.equal(canonicalJson({ z: [-0, true], a: "é" }), '{"a":"é","z":[0,true]}');
  assert.doesNotThrow(() => assertUtf8Bytes("é".repeat(8192), 16384));
  assert.throws(() => assertUtf8Bytes("é".repeat(8193), 16384));
  for (const v of [NaN, Infinity, undefined, 1n, "\ud800", { x: undefined }, new Date(), Array(1)])
    assert.throws(() => canonicalJson(v));
  const expected = createHash("sha256").update('fortipi:operation:v1\n{"a":1,"b":2}').digest("hex");
  assert.equal(await digestJson("operation", { b: 2, a: 1 }), expected);
  assert.notEqual(await digestJson("assignment", { a: 1, b: 2 }), expected);
  const a = { path: "a", type: "directory" as const, mode: 493 as const };
  const z = { path: "z", type: "directory" as const, mode: 493 as const };
  assert.equal(
    await manifestDigest({ version: 1, entries: [z, a] }),
    await manifestDigest({ version: 1, entries: [a, z] }),
  );
});
test("local stages carry explicit put/delete/mkdir metadata bound to their enclosing upload", async () => {
  const stage = await completeLocalStage();
  const request = {
    ...scope,
    kind: "prepare",
    commitId: "commit_1",
    expectedManifestHash: hash,
    mode: stage,
  };
  const valid = get("LocalPrepare");
  assert.equal(valid(request), true, JSON.stringify(valid.errors));
  assert.deepEqual(
    stage.mutations.map((mutation) => mutation.kind),
    ["put", "delete", "mkdir"],
  );
  const manifestJson =
    '{"entries":[{"mode":493,"path":"new-dir","type":"directory"},{"mode":420,"path":"result.txt","sha256":"' +
    hash +
    '","size":3,"type":"file"}],"version":1}';
  const expectedManifest = createHash("sha256")
    .update(`fortipi:manifest:v1\n${manifestJson}`)
    .digest("hex");
  const stageJson =
    '{"manifestHash":"' +
    expectedManifest +
    '","mutations":[{"kind":"put","mode":420,"path":"result.txt","sha256":"' +
    hash +
    '","size":3},{"kind":"delete","path":"old.txt"},{"kind":"mkdir","mode":493,"path":"new-dir"}],"uploadId":"upload_1"}';
  assert.equal(stage.postManifestHash, expectedManifest);
  assert.equal(
    stage.stagedDigest,
    createHash("sha256").update(`fortipi:local-stage:v1\n${stageJson}`).digest("hex"),
  );
  validateLocalLease(request, "prepare", lease.expiresAt - 1);
  await assert.doesNotReject(() => validateLocalStage(stage));
  await assert.rejects(
    validateLocalStage({ ...stage, stagedDigest: "b".repeat(64) }),
    /staged_digest/,
  );
  await assert.rejects(
    validateLocalStage({ ...stage, postManifestHash: "b".repeat(64) }),
    /post_manifest_hash/,
  );
  await assert.rejects(validateLocalStage({ ...stage, uploadId: "other_upload" }), /staged_digest/);
  const reverse = { ...stage, mutations: [...stage.mutations].reverse() };
  assert.notEqual(
    await localStageDigest(reverse),
    stage.stagedDigest,
    "Mutation order is part of the v1 local-stage preimage",
  );
  await assert.rejects(validateLocalStage(reverse), /staged_digest/);
  const replaceDirectory = {
    ...stage,
    mutations: [{ kind: "delete" as const, path: "new-dir" }, ...stage.mutations],
  };
  replaceDirectory.stagedDigest = await localStageDigest(replaceDirectory);
  await assert.doesNotReject(() => validateLocalStage(replaceDirectory));
  await assert.rejects(
    validateLocalStage({
      ...stage,
      mutations: stage.mutations.map((mutation) =>
        mutation.kind === "delete" ? { ...mutation, path: "different-old.txt" } : mutation,
      ),
    }),
    /staged_digest/,
  );
  for (const size of [4, 5])
    await assert.rejects(
      validateLocalStage({
        ...stage,
        mutations: stage.mutations.map((mutation) =>
          mutation.kind === "put" ? { ...mutation, size } : mutation,
        ),
      }),
      /put_metadata/,
    );
  await assert.rejects(
    validateLocalStage({
      ...stage,
      mutations: stage.mutations.map((mutation) =>
        mutation.kind === "mkdir" ? { ...mutation, path: "missing-dir" } : mutation,
      ),
    }),
    /mkdir_metadata/,
  );
  await assert.rejects(
    validateLocalStage({
      ...stage,
      mutations: [...stage.mutations, { kind: "delete", path: "result.txt" }],
    }),
    /delete_metadata/,
  );
  for (const field of ["manifest", "mutations"]) {
    const incomplete = { ...stage };
    Reflect.deleteProperty(incomplete, field);
    assert.equal(valid({ ...request, mode: incomplete }), false);
  }
  const legacyMutations = stage.mutations.map((mutation) =>
    mutation.kind === "put" ? { ...mutation, uploadId: "other_upload" } : mutation,
  );
  assert.equal(
    valid({ ...request, mode: { ...stage, mutations: legacyMutations } }),
    false,
    "Per-put upload IDs are forbidden",
  );
  assert.equal(
    get("UploadBegin")({
      requestId: "request_1",
      baseRevision: lease.baseRevision,
      lease,
      operationId: lease.operationId,
      commitId: "commit_1",
      manifestHash: stage.postManifestHash,
      manifest: stage.manifest,
      mutations: stage.mutations,
    }),
    true,
    "Initial puts do not need an unallocated server upload ID",
  );
  const nativeMode = {
    kind: "native-execution",
    jobId: "job_1",
    executionId: "execution_1",
    assignmentDigest: hash,
  };
  assert.equal(valid({ ...request, mode: nativeMode }), true);
  assert.equal(valid({ ...request, mode: { ...nativeMode, manifest: stage.manifest } }), false);
  assert.throws(() => validateLocalLease(request, "prepare", lease.expiresAt), /expired_lease/);
  assert.throws(
    () => validateLocalLease({ ...request, baseRevision: "wrong_base" }, "prepare", 1),
    /lease identity/,
  );
  const oversized = {
    ...stage,
    mutations: Array.from({ length: 3000 }, (_, i) => ({
      kind: "delete" as const,
      path: `old-${i}-${"x".repeat(400)}`,
    })),
  };
  assert.equal(
    valid({ ...request, mode: oversized }),
    true,
    "The frame-byte ceiling is an additional transport requirement",
  );
  await assert.rejects(validateLocalStage(oversized), /payload_too_large/);
});
test("local stage directory recreation clears earlier descendant claims in mutation order", async () => {
  const directory = { path: "tree", type: "directory" as const, mode: 493 as const };
  const oldFile = {
    path: "tree/old.txt",
    type: "file" as const,
    mode: 420 as const,
    size: 3,
    sha256: hash,
  };
  const newFile = { ...oldFile, path: "tree/new.txt" };
  const put = {
    kind: "put" as const,
    path: oldFile.path,
    sha256: hash,
    size: 3,
    mode: 420 as const,
  };
  const mutations = [
    put,
    { kind: "delete" as const, path: directory.path },
    { kind: "mkdir" as const, path: directory.path, mode: 493 as const },
  ];
  for (const recreateChild of [false, true]) {
    const input = {
      uploadId: "upload_1",
      manifest: {
        version: 1 as const,
        entries: recreateChild ? [directory, newFile] : [directory],
      },
      mutations: recreateChild ? [...mutations, { ...put, path: newFile.path }] : mutations,
    };
    const stage = {
      kind: "staged-change" as const,
      ...input,
      postManifestHash: await manifestDigest(input.manifest),
      stagedDigest: await localStageDigest(input),
    };
    assert.equal(
      get("LocalPrepare")({
        ...scope,
        kind: "prepare",
        commitId: "commit_1",
        expectedManifestHash: hash,
        mode: stage,
      }),
      true,
    );
    await assert.doesNotReject(() => validateLocalStage(stage));
    // Moving the put after recreation makes its metadata a required final claim again.
    const reordered = { ...stage, mutations: [...mutations.slice(1), put] };
    reordered.stagedDigest = await localStageDigest(reordered);
    await assert.rejects(validateLocalStage(reordered), /put_metadata/);
  }
});
test("local intent and final commit have independent immutable byte oracles", async () => {
  const input = {
    commitId: "commit_1",
    scope,
    preparationId: "preparation_1",
    preManifestHash: hash,
    expectedPostManifestHash: hash,
  };
  const leaseJson =
    '{"baseRevision":"revision_1","credential":{"credentialId":"credential_1","generation":2,"grantVersion":3},"executorGeneration":4,"executorId":"executor_1","fence":"7","jobId":"job_1","leaseId":"lease_1","operationId":"operation_1","ownerKind":"job","registrationId":"registration_1","workspaceId":"workspace_1"}';
  const scopeJson =
    '{"baseRevision":"revision_1","bindingVersion":1,"credential":{"credentialId":"credential_1","generation":2,"grantVersion":3},"deadline":50000,"executorGeneration":4,"executorId":"executor_1","lease":' +
    leaseJson +
    ',"operationDigest":"' +
    hash +
    '","operationId":"operation_1","rootBindingId":"root_1","workspaceId":"workspace_1"}';
  const intentJson =
    '{"commitId":"commit_1","expectedPostManifestHash":"' +
    hash +
    '","preManifestHash":"' +
    hash +
    '","preparationId":"preparation_1","scope":' +
    scopeJson +
    "}";
  const intentDigest = await localIntentDigest(input);
  assert.equal(
    intentDigest,
    createHash("sha256").update(`fortipi:local-intent:v1\n${intentJson}`).digest("hex"),
  );
  const intent = { ...input, intentDigest, state: "pending_apply" };
  assert.equal(get("LocalCommitIntent")(intent), true);
  assert.equal(get("LocalCommitIntent")({ ...intent, commitDigest: intentDigest }), false);
  const { intentDigest: _intentHash, ...missingIntentHash } = intent;
  assert.equal(get("LocalCommitIntent")(missingIntentHash), false);
  const renewedScope = { ...scope, lease: { ...lease, leaseVersion: 2, expiresAt: 40000 } };
  assert.equal(await localIntentDigest({ ...input, scope: renewedScope }), intentDigest);
  const { expectedPostManifestHash: _expected, ...withoutExpectedPost } = input;
  const withoutExpectedJson =
    '{"commitId":"commit_1","preManifestHash":"' +
    hash +
    '","preparationId":"preparation_1","scope":' +
    scopeJson +
    "}";
  assert.equal(
    await localIntentDigest(withoutExpectedPost),
    createHash("sha256").update(`fortipi:local-intent:v1\n${withoutExpectedJson}`).digest("hex"),
  );
  assert.notEqual(await localIntentDigest(withoutExpectedPost), intentDigest);
  for (const changed of [
    { ...input, preparationId: "preparation_2" },
    { ...input, expectedPostManifestHash: "b".repeat(64) },
    { ...input, scope: { ...scope, deadline: 50001 } },
    { ...input, scope: { ...scope, bindingVersion: 2 } },
    { ...input, scope: { ...scope, lease: { ...lease, fence: "8" } } },
  ])
    assert.notEqual(await localIntentDigest(changed), intentDigest);
  // Only a verified applied observation supplies final observationSeq/postManifestHash.
  assert.equal(get("LocalObservation")(observation), true);
  const finalInput = {
    commitId: input.commitId,
    operationId: scope.operationId,
    jobId: lease.jobId,
    workspaceId: scope.workspaceId,
    baseRevision: scope.baseRevision,
    manifestHash: observation.postManifestHash,
    leaseIdentity: scope.lease,
    storage: {
      kind: "local" as const,
      preparationId: observation.preparationId,
      observationSeq: observation.observationSeq,
      preManifestHash: observation.preManifestHash,
      postManifestHash: observation.postManifestHash,
    },
  };
  const finalJson =
    '{"baseRevision":"revision_1","commitId":"commit_1","jobId":"job_1","leaseIdentity":' +
    leaseJson +
    ',"manifestHash":"' +
    hash +
    '","operationId":"operation_1","storage":{"kind":"local","observationSeq":1,"postManifestHash":"' +
    hash +
    '","preManifestHash":"' +
    hash +
    '","preparationId":"preparation_1"},"workspaceId":"workspace_1"}';
  const finalDigest = await commitDigest(finalInput);
  assert.equal(
    finalDigest,
    createHash("sha256").update(`fortipi:commit:v1\n${finalJson}`).digest("hex"),
  );
  assert.notEqual(finalDigest, intentDigest);
  assert.equal(
    await commitDigest({ ...finalInput, leaseIdentity: renewedScope.lease }),
    finalDigest,
  );
  assert.notEqual(
    await commitDigest({ ...finalInput, storage: { ...finalInput.storage, observationSeq: 2 } }),
    finalDigest,
  );
  assert.notEqual(
    await commitDigest({
      ...finalInput,
      manifestHash: "b".repeat(64),
      storage: { ...finalInput.storage, postManifestHash: "b".repeat(64) },
    }),
    finalDigest,
  );
});
test("workspace lease digest has an independent non-job byte oracle and projects observations", async () => {
  const input = {
    deploymentId: "deployment_1",
    operationId: "workspace_operation_1",
    workspaceId: "workspace_1",
    bindingVersion: 1,
    baseRevision: "revision_1",
    target: { kind: "backend" as const, backendId: "workspace_1", generation: 1 },
    credential: { credentialId: "credential_1", generation: 2, grantVersion: 3 },
    deadline: 50000,
  };
  const bytes =
    '{"baseRevision":"revision_1","bindingVersion":1,"credential":{"credentialId":"credential_1","generation":2,"grantVersion":3},"deadline":50000,"deploymentId":"deployment_1","operationId":"workspace_operation_1","target":{"backendId":"workspace_1","generation":1,"kind":"backend"},"workspaceId":"workspace_1"}';
  const expected = createHash("sha256")
    .update(`fortipi:workspace-lease:v1\n${bytes}`)
    .digest("hex");
  assert.equal(get("WorkspaceLeaseDigestInput")(input), true);
  assert.equal(await workspaceLeaseDigest(input), expected);
  // Structural internal values can carry observations; the named immutable preimage must exclude them explicitly.
  const observed = {
    ...input,
    expiresAt: 30000,
    leaseVersion: 1,
    connectionEpoch: 8,
    principalId: "not-a-preimage-field",
    agentId: "not-required",
    conversationId: "not-required",
    target: { ...input.target, expiresAt: 30000, connectionEpoch: 8 },
    credential: {
      ...input.credential,
      role: "admin",
      grants: ["not-a-preimage-field"],
      authenticatedAt: 1,
    },
  };
  assert.equal(
    await workspaceLeaseDigest(observed),
    expected,
    "mutable/auth observations excluded",
  );
  const changedObservations = {
    ...observed,
    expiresAt: 40000,
    leaseVersion: 2,
    connectionEpoch: 9,
    target: { ...observed.target, expiresAt: 40000, connectionEpoch: 9 },
  };
  assert.equal(await workspaceLeaseDigest(changedObservations), expected);
  assert.equal(
    get("WorkspaceLeaseDigestInput")(observed),
    false,
    "Wire preimages remain closed even though internal structural values are projected",
  );
  for (const changed of [
    { ...input, operationId: "workspace_operation_2" },
    { ...input, bindingVersion: 2 },
    { ...input, baseRevision: "revision_2" },
    { ...input, deadline: 50001 },
    { ...input, credential: { ...input.credential, credentialId: "credential_2" } },
    { ...input, credential: { ...input.credential, generation: 3 } },
    { ...input, credential: { ...input.credential, grantVersion: 4 } },
    { ...input, target: { ...input.target, generation: 2 } },
    { ...input, target: { kind: "executor" as const, executorId: "executor_1", generation: 4 } },
  ])
    assert.notEqual(await workspaceLeaseDigest(changed), expected);
  assert.equal(
    get("WorkspaceLeaseDigestInput")({
      ...input,
      target: { kind: "computer", workspaceId: "workspace_1" },
    }),
    false,
  );
  assert.equal(get("WorkspaceLeaseDigestInput")({ ...input, jobId: "invented" }), false);
});
