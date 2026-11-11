import { knownEventTypes } from "./generated/schemas.js";
import type {
  Assignment,
  AssignmentDigestInput,
  ChunkInventory,
  ClientEvent,
  CommitDigestInput,
  CommitReceipt,
  InfrastructurePolicy,
  LocalCommitIntent,
  LocalPrepare,
  LocalScope,
  Manifest,
  OperationDigestInput,
  ProviderAuthPut,
  TransferDescriptor,
  UploadBegin,
} from "./generated/types.js";
export const protocolVersion = "1.0" as const;
export const schemaVersion = "1.0.0" as const;
export const wireLimits = {
  jsonBytes: 1048576,
  outputFrameBytes: 16384,
  inlineTailBytes: 65536,
  artifactBytes: 16777216,
  manifestBytes: 524288,
  manifestEntries: 4096,
  pathBytes: 1024,
  fileBytes: 67108864,
  chunkBytes: 262144,
  revisionBytes: 268435456,
  activeUploads: 2,
  uploadTtlMs: 900000,
  leaseMs: 30000,
  renewalMs: 10000,
  deadlineMs: 86400000,
  ticketMs: 30000,
  ticketMaxMs: 60000,
  replayPage: 100,
  socketBytes: 1048576,
  socketFrames: 256,
  transferMs: 60000,
  rendezvousMs: 10000,
  idleMs: 10000,
  chunkMs: 30000,
  matchedChunks: 2,
  transfers: 4,
} as const;
export const freeInfrastructurePolicy: InfrastructurePolicy = {
  version: 1,
  profile: "free",
  accountPlan: "unknown",
  capabilities: [],
  bounds: {
    objectBytes: 134217728,
    installBytes: 536870912,
    headroomFraction: 0.25,
    fileBytes: 4194304,
    snapshotBytes: 16777216,
    stagingBytesPerWorkspace: 16777216,
    manifestEntries: 512,
    retainedVersions: 8,
    workspaceBytes: 67108864,
    inlineTailBytes: 32768,
    artifactBytes: 1048576,
    outputBytesPerJob: 8388608,
    conversationEvents: 2000,
    conversationBytes: 8388608,
    activeMutatingJobs: 1,
    queuedAdmissions: 4,
    requestsPerPrincipalMinute: 30,
    requestsPerInstallMinute: 120,
    sqlPageRows: 100,
    transferConcurrency: 4,
  },
};
/** Apply only after schema validation and durable consumer application. Volatile frames never advance. */
export function nextEventCursor(current: number, event: ClientEvent): number {
  if (!Number.isSafeInteger(current) || current < 0) throw new Error("cursor.invalid");
  if (event.durability === "volatile") return current;
  if (event.eventSeq <= current) return current;
  if (current === Number.MAX_SAFE_INTEGER || event.eventSeq !== current + 1)
    throw new Error("resync_required");
  return event.eventSeq;
}
export function isKnownEventType(type: string): boolean {
  return (knownEventTypes as readonly string[]).includes(type);
}
export function incrementSafe(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER)
    throw new Error("counter_exhausted");
  return value + 1;
}
function validString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error("lone surrogate");
    } else if (n >= 0xdc00 && n <= 0xdfff) throw new Error("lone surrogate");
  }
}
/** JSON Schema string lengths count code points; transports must also enforce encoded bytes. */
export function assertUtf8Bytes(value: string, maximum: number): void {
  validString(value);
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    new TextEncoder().encode(value).length > maximum
  )
    throw new Error("payload_too_large");
}
/** Required in addition to structural schema validation: OAuth limits are encoded bytes. */
export function validateProviderAuthPut(input: ProviderAuthPut): void {
  assertUtf8Bytes(input.credential.access, 16384);
  assertUtf8Bytes(input.credential.refresh, 16384);
  assertUtf8Bytes(canonicalJson(input), 65536);
}
/** Browser Origin syntax/canonicalization; the authority separately checks its exact allowlist. */
export function validateBrowserOrigin(origin: string): void {
  const parsed = new URL(origin);
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== origin)
    throw new Error("invalid origin");
}
/** Protocol canonical JSON: UTF-16 key order, JSON encoding, -0 normalization; never accepts non-JSON values. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  function visit(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "boolean") return String(v);
    if (typeof v === "string") {
      validString(v);
      return JSON.stringify(v);
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("non-finite number");
      return JSON.stringify(v);
    }
    if (typeof v !== "object" || !v) throw new Error("non-JSON value");
    if (active.has(v)) throw new Error("cyclic JSON");
    active.add(v);
    let result: string;
    if (Array.isArray(v)) {
      if (
        Object.getOwnPropertySymbols(v).length ||
        Object.keys(v).length !== v.length ||
        Object.keys(v).some((k, i) => String(i) !== k)
      )
        throw new Error("sparse/extended array");
      result = `[${Object.keys(v)
        .map((k) => {
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d || !("value" in d)) throw new Error("JSON accessor");
          return visit(d.value);
        })
        .join(",")}]`;
    } else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        throw new Error("non-JSON object");
      if (Object.getOwnPropertySymbols(v).length) throw new Error("symbol key");
      result = `{${Object.keys(v)
        .sort()
        .map((k) => {
          validString(k);
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d || !("value" in d)) throw new Error("JSON accessor");
          return `${JSON.stringify(k)}:${visit(d.value)}`;
        })
        .join(",")}}`;
    }
    active.delete(v);
    return result;
  }
  return visit(value);
}
export type DigestDomain =
  | "manifest"
  | "operation"
  | "assignment"
  | "commit"
  | "local-stage"
  | "local-intent";
export async function digestJson(domain: DigestDomain, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`fortipi:${domain}:v1\n${canonicalJson(value)}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}
function operationPreimage(input: OperationDigestInput): OperationDigestInput {
  return {
    deploymentId: input.deploymentId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    tool: input.tool,
    arguments: input.arguments,
    workspaceId: input.workspaceId,
    baseRevision: input.baseRevision,
    target:
      input.target.kind === "executor"
        ? {
            kind: "executor",
            executorId: input.target.executorId,
            generation: input.target.generation,
          }
        : {
            kind: "backend",
            backendId: input.target.backendId,
            generation: input.target.generation,
          },
    policyVersion: input.policyVersion,
    grantVersion: input.grantVersion,
    deadline: input.deadline,
  };
}
/** Project the named preimage: structural TypeScript inputs can also carry mutable observations. */
export const operationDigest = (input: OperationDigestInput): Promise<string> =>
  digestJson("operation", operationPreimage(input));
export const assignmentDigest = (input: AssignmentDigestInput): Promise<string> =>
  digestJson("assignment", {
    operation: operationPreimage(input.operation),
    executionId: input.executionId,
    reservationId: input.reservationId,
    leaseId: input.leaseId,
    fence: input.fence,
    executorGeneration: input.executorGeneration,
  });
/** Reconstruct the v1 preimage from an exactly schema-validated received assignment. */
export function operationForAssignment(input: Assignment): OperationDigestInput {
  return {
    deploymentId: input.operationContext.deploymentId,
    agentId: input.operationContext.agentId,
    conversationId: input.operationContext.conversationId,
    policyVersion: input.operationContext.policyVersion,
    tool: input.tool,
    arguments: input.arguments,
    workspaceId: input.workspaceId,
    baseRevision: input.identity.baseRevision,
    target: input.identity.target,
    deadline: input.identity.deadline,
    grantVersion: input.identity.lease.credential.grantVersion,
  };
}
/** Requires exact schema parsing first. Await before ledger admission/spawn; current authority checks remain separate. */
export async function validateAssignment(input: Assignment): Promise<void> {
  const { identity } = input;
  const { lease, target } = identity;
  if (
    lease.ownerKind !== "job" ||
    lease.jobId !== identity.jobId ||
    lease.workspaceId !== input.workspaceId ||
    lease.baseRevision !== identity.baseRevision ||
    target.kind !== "executor" ||
    lease.executorId !== target.executorId ||
    lease.executorGeneration !== target.generation
  )
    throw new Error("assignment.invalid: identity");
  const operation = operationForAssignment(input);
  const expectedOperation = await operationDigest(operation);
  if (identity.operationDigest !== expectedOperation)
    throw new Error("assignment.invalid: operation_digest");
  const expectedAssignment = await assignmentDigest({
    operation,
    executionId: identity.executionId,
    reservationId: input.reservationId,
    leaseId: lease.leaseId,
    fence: lease.fence,
    executorGeneration: lease.executorGeneration,
  });
  if (identity.assignmentDigest !== expectedAssignment)
    throw new Error("assignment.invalid: assignment_digest");
}
export type LocalStagedChange = Extract<LocalPrepare["mode"], { kind: "staged-change" }>;
export type LocalStageDigestInput = Pick<LocalStagedChange, "uploadId" | "manifest" | "mutations">;
async function localStagePreimage(input: LocalStageDigestInput) {
  return {
    uploadId: input.uploadId,
    manifestHash: await manifestDigest(input.manifest),
    mutations: input.mutations,
  };
}
export async function localStageDigest(input: LocalStageDigestInput): Promise<string> {
  return digestJson("local-stage", await localStagePreimage(input));
}
export type LocalIntentDigestInput = Pick<
  LocalCommitIntent,
  "commitId" | "scope" | "preparationId" | "preManifestHash" | "expectedPostManifestHash"
>;
/** Immutable pending-apply identity. Final commitDigest additionally needs the actual observation. */
export async function localIntentDigest(input: LocalIntentDigestInput): Promise<string> {
  const scope = input.scope;
  const { leaseVersion: _version, expiresAt: _expiry, ...leaseIdentity } = scope.lease;
  return digestJson("local-intent", {
    commitId: input.commitId,
    scope: {
      operationId: scope.operationId,
      operationDigest: scope.operationDigest,
      workspaceId: scope.workspaceId,
      bindingVersion: scope.bindingVersion,
      rootBindingId: scope.rootBindingId,
      executorId: scope.executorId,
      executorGeneration: scope.executorGeneration,
      credential: scope.credential,
      baseRevision: scope.baseRevision,
      lease: leaseIdentity,
      deadline: scope.deadline,
    },
    preparationId: input.preparationId,
    preManifestHash: input.preManifestHash,
    ...(input.expectedPostManifestHash === undefined
      ? {}
      : { expectedPostManifestHash: input.expectedPostManifestHash }),
  });
}
/** Parse the exact schema first; caller also validates LocalScope/lease and the complete encoded frame before effects. */
export async function validateLocalStage(input: LocalStagedChange): Promise<void> {
  assertUtf8Bytes(canonicalJson(input), wireLimits.jsonBytes);
  const preimage = await localStagePreimage(input);
  if (input.postManifestHash !== preimage.manifestHash)
    throw new Error("local-stage.invalid: post_manifest_hash");
  const entries = new Map(input.manifest.entries.map((entry) => [entry.path, entry]));
  const claimed = new Set<string>();
  const replaced = new Set<string>();
  for (const mutation of input.mutations) validateRelativePath(mutation.path);
  // Check final explicit claims, respecting later replacement/deletion. Applying to the real base is actor-owned.
  for (const mutation of [...input.mutations].reverse()) {
    const ancestors = mutation.path.split("/");
    ancestors.pop();
    let superseded = claimed.has(mutation.path);
    while (ancestors.length && !superseded) {
      superseded = replaced.has(ancestors.join("/"));
      ancestors.pop();
    }
    // Recreating a directory supersedes its own deletion, but that deletion still clears earlier descendants.
    if (mutation.kind !== "mkdir") replaced.add(mutation.path);
    if (superseded) continue;
    claimed.add(mutation.path);
    if (mutation.kind === "put") {
      const entry = entries.get(mutation.path);
      if (
        entry?.type !== "file" ||
        entry.sha256 !== mutation.sha256 ||
        entry.size !== mutation.size ||
        entry.mode !== mutation.mode
      )
        throw new Error("local-stage.invalid: put_metadata");
    } else if (mutation.kind === "mkdir") {
      const entry = entries.get(mutation.path);
      if (entry?.type !== "directory" || entry.mode !== mutation.mode)
        throw new Error("local-stage.invalid: mkdir_metadata");
    } else if (entries.has(mutation.path)) {
      throw new Error("local-stage.invalid: delete_metadata");
    }
  }
  const expectedStage = await digestJson("local-stage", preimage);
  if (input.stagedDigest !== expectedStage) throw new Error("local-stage.invalid: staged_digest");
}
/** Exact schema parsing precedes this metadata check; the receiver still verifies actual file bytes. */
export function validateChunkInventory(chunks: ChunkInventory, size: number): void {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > wireLimits.fileBytes ||
    !Number.isSafeInteger(chunks.chunkBytes) ||
    chunks.chunkBytes < 1 ||
    chunks.chunkBytes > wireLimits.chunkBytes ||
    chunks.chunkHashes.length > 256 ||
    chunks.chunkHashes.length !== Math.ceil(size / chunks.chunkBytes) ||
    chunks.chunkHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
  )
    throw new Error("upload.invalid: chunk_inventory");
}
/** Validate all declared puts, including ones superseded by later ordered mutations. */
export function validateUploadBlobs(input: UploadBegin, options: { required: boolean }): void {
  assertUtf8Bytes(canonicalJson(input), wireLimits.jsonBytes);
  const puts = new Map<string, number>();
  for (const mutation of input.mutations) {
    if (mutation.kind !== "put") continue;
    const prior = puts.get(mutation.sha256);
    if (prior !== undefined && prior !== mutation.size)
      throw new Error("upload.invalid: inconsistent_file_size");
    puts.set(mutation.sha256, mutation.size);
  }
  if (input.blobs === undefined) {
    if (options.required) throw new Error("upload.invalid: missing_blobs");
    return;
  }
  const seen = new Set<string>();
  for (const blob of input.blobs) {
    const size = puts.get(blob.sha256);
    if (size === undefined || seen.has(blob.sha256))
      throw new Error("upload.invalid: unexpected_blob");
    validateChunkInventory(blob.chunks, size);
    seen.add(blob.sha256);
  }
  if (seen.size !== puts.size) throw new Error("upload.invalid: missing_blobs");
}
export function commitDigest(input: CommitDigestInput): Promise<string> {
  const lease = input.leaseIdentity;
  return digestJson("commit", {
    commitId: input.commitId,
    ...(input.uploadId === undefined ? {} : { uploadId: input.uploadId }),
    operationId: input.operationId,
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    workspaceId: input.workspaceId,
    baseRevision: input.baseRevision,
    manifestHash: input.manifestHash,
    leaseIdentity: {
      leaseId: lease.leaseId,
      operationId: lease.operationId,
      ownerKind: lease.ownerKind,
      ...(lease.ownerKind === "job" ? { jobId: lease.jobId } : {}),
      credential: {
        credentialId: lease.credential.credentialId,
        generation: lease.credential.generation,
        grantVersion: lease.credential.grantVersion,
      },
      registrationId: lease.registrationId,
      workspaceId: lease.workspaceId,
      executorId: lease.executorId,
      executorGeneration: lease.executorGeneration,
      fence: lease.fence,
      baseRevision: lease.baseRevision,
    },
    storage: input.storage,
  });
}
/** Explicit projection for all public HTTP, event and executor receipt delivery. */
export function publicCommitReceipt(receipt: CommitReceipt): CommitReceipt {
  const common = {
    commitId: receipt.commitId,
    ...(receipt.jobId === undefined ? {} : { jobId: receipt.jobId }),
    operationId: receipt.operationId,
    workspaceId: receipt.workspaceId,
    commitDigest: receipt.commitDigest,
    baseRevision: receipt.baseRevision,
    revision: receipt.revision,
    manifestHash: receipt.manifestHash,
    sourceFactId: receipt.sourceFactId,
    committedAt: receipt.committedAt,
  };
  return receipt.providerKind === "computer"
    ? { ...common, providerKind: "computer", storeRef: { stageId: receipt.storeRef.stageId } }
    : {
        ...common,
        providerKind: "local",
        preparationId: receipt.preparationId,
        observationSeq: receipt.observationSeq,
      };
}
export function decodeWorkspacePath(encoded: string): string {
  const path = decodeURIComponent(encoded);
  validateRelativePath(path);
  return path;
}
export function validateRelativePath(path: string): void {
  validString(path);
  if (
    path !== path.normalize("NFC") ||
    new TextEncoder().encode(path).length > 1024 ||
    /[\\:<>"|?*]/u.test(path) ||
    Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error("invalid path");
  const segments = path.split("/");
  for (const segment of segments) {
    const s = segment.toLowerCase();
    if (
      !s ||
      s === "." ||
      s === ".." ||
      /[. ]$/.test(s) ||
      /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/.test(s)
    )
      throw new Error("path alias");
    if (
      [
        ".fortipi",
        ".git",
        "node_modules",
        ".cache",
        ".next",
        "dist",
        "build",
        "coverage",
        ".ssh",
        ".aws",
        ".npmrc",
        ".pnpmrc",
        "auth.json",
      ].includes(s) ||
      s.startsWith(".env") ||
      /\.(key|pem)$/.test(s) ||
      /^credentials.*\.json$/.test(s)
    )
      throw new Error("excluded path");
  }
}
export function validateManifest(
  manifest: Manifest,
  caseBehavior: "sensitive" | "insensitive" = "sensitive",
): void {
  const paths = new Map<string, string>();
  const spellings = new Map<string, string>();
  if (manifest.version !== 1 || manifest.entries.length > 4096) throw new Error("manifest limit");
  if (new TextEncoder().encode(canonicalJson(manifest)).length > 524288)
    throw new Error("manifest bytes");
  let bytes = 0;
  for (const entry of manifest.entries) {
    validateRelativePath(entry.path);
    const key = caseBehavior === "insensitive" ? entry.path.toLowerCase() : entry.path;
    if (paths.has(key)) throw new Error("path collision");
    paths.set(key, entry.type);
    if (caseBehavior === "insensitive") {
      const segments = entry.path.split("/");
      for (let i = 1; i <= segments.length; i++) {
        const prefix = segments.slice(0, i).join("/");
        const folded = prefix.toLowerCase();
        if (spellings.has(folded) && spellings.get(folded) !== prefix)
          throw new Error("path collision");
        spellings.set(folded, prefix);
      }
    }
    if (entry.type === "file") {
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > 67108864 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        (entry.mode !== 420 && entry.mode !== 493)
      )
        throw new Error("invalid file");
      bytes += entry.size;
    } else if (entry.mode !== 493) throw new Error("invalid directory mode");
    if (bytes > 268435456) throw new Error("revision bytes");
  }
  for (const path of paths.keys()) {
    const segments = path.split("/");
    segments.pop();
    while (segments.length) {
      if (paths.get(segments.join("/")) === "file") throw new Error("file ancestor");
      segments.pop();
    }
  }
}
export async function manifestDigest(manifest: Manifest): Promise<string> {
  validateManifest(manifest);
  const encoder = new TextEncoder();
  const entries = [...manifest.entries].sort((a, b) => {
    const x = encoder.encode(a.path),
      y = encoder.encode(b.path);
    for (let i = 0; i < Math.min(x.length, y.length); i++)
      if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
    return x.length - y.length;
  });
  return digestJson("manifest", { version: 1, entries });
}
export function effectiveLimits(policy: InfrastructurePolicy) {
  return {
    fileBytes: Math.min(policy.bounds.fileBytes, wireLimits.fileBytes),
    snapshotBytes: Math.min(policy.bounds.snapshotBytes, wireLimits.revisionBytes),
    manifestEntries: Math.min(policy.bounds.manifestEntries, wireLimits.manifestEntries),
    inlineTailBytes: Math.min(policy.bounds.inlineTailBytes, wireLimits.inlineTailBytes),
    artifactBytes: Math.min(policy.bounds.artifactBytes, wireLimits.artifactBytes),
    transferConcurrency: Math.min(policy.bounds.transferConcurrency, wireLimits.transfers),
  };
}
export function requireCapability(
  policy: InfrastructurePolicy,
  capability: "loader" | "containers",
  deploymentId: string,
): boolean {
  return (
    policy.accountPlan === "paid" &&
    policy.capabilities.some(
      (c) =>
        c.capability === capability &&
        c.state === "available" &&
        c.accountPlan === "paid" &&
        c.deploymentId === deploymentId,
    )
  );
}
/** Pure descriptor preconditions; it does not authenticate peers, reserve capacity or prove stored bytes. */
export function validateTransfer(descriptor: TransferDescriptor, now: number): void {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now >= descriptor.expiresAt ||
    descriptor.expiresAt > descriptor.deadline ||
    descriptor.expiresAt - now > 60000
  )
    throw new Error("expired transfer");
  if (descriptor.lease && descriptor.expiresAt > descriptor.lease.expiresAt)
    throw new Error("transfer lease");
  if (descriptor.content.kind === "workspace-file") validateRelativePath(descriptor.content.path);
  if (descriptor.lease) {
    const lease = descriptor.lease;
    if (
      lease.workspaceId !== descriptor.workspaceId ||
      lease.operationId !== descriptor.operationId ||
      lease.baseRevision !== descriptor.baseRevision ||
      lease.executorId !== descriptor.executorId ||
      lease.executorGeneration !== descriptor.executorGeneration ||
      lease.credential.credentialId !== descriptor.credential.credentialId ||
      lease.credential.generation !== descriptor.credential.generation ||
      lease.credential.grantVersion !== descriptor.credential.grantVersion ||
      (lease.ownerKind === "job"
        ? lease.jobId !== descriptor.jobId
        : descriptor.jobId !== undefined)
    )
      throw new Error("transfer lease identity");
  }
  if (
    descriptor.chunkBytes < 1 ||
    descriptor.chunkBytes > 262144 ||
    descriptor.chunkHashes.length !== Math.ceil(descriptor.size / descriptor.chunkBytes) ||
    descriptor.chunkHashes.some((h) => !/^[a-f0-9]{64}$/.test(h))
  )
    throw new Error("transfer chunks");
  if ((descriptor.jobId === undefined) !== (descriptor.executionId === undefined))
    throw new Error("job identity");
  if (descriptor.purpose === "local-stage" && !descriptor.lease) throw new Error("stage lease");
  if (
    descriptor.purpose === "local-read" &&
    (descriptor.direction !== "from-executor" ||
      descriptor.content.kind !== "workspace-file" ||
      descriptor.lease)
  )
    throw new Error("read direction");
  if (
    descriptor.purpose === "local-stage" &&
    (descriptor.direction !== "to-executor" ||
      descriptor.content.kind !== "workspace-file" ||
      !descriptor.content.uploadId)
  )
    throw new Error("stage direction");
  if (
    descriptor.purpose === "output" &&
    (descriptor.direction !== "from-executor" ||
      descriptor.content.kind !== "job-output" ||
      !descriptor.jobId)
  )
    throw new Error("output scope");
  if (
    !descriptor.consumer.workspaceIds.includes(descriptor.workspaceId) ||
    !descriptor.consumer.executorIds.includes(descriptor.executorId)
  )
    throw new Error("consumer scope");
}
/** Only immutable lease correlation and temporal eligibility. Owners still check current grants/floors/ledger/CAS. */
export function validateLocalLease(
  scope: LocalScope,
  phase: "prepare" | "apply" | "commit" | "observe" | "receipt",
  now: number,
): void {
  const lease = scope.lease;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    lease.workspaceId !== scope.workspaceId ||
    lease.operationId !== scope.operationId ||
    lease.baseRevision !== scope.baseRevision ||
    lease.executorId !== scope.executorId ||
    lease.executorGeneration !== scope.executorGeneration ||
    lease.credential.credentialId !== scope.credential.credentialId ||
    lease.credential.generation !== scope.credential.generation ||
    lease.credential.grantVersion !== scope.credential.grantVersion
  )
    throw new Error("workspace.conflict: lease identity");
  if (
    ["prepare", "apply", "commit"].includes(phase) &&
    (now >= lease.expiresAt || now >= scope.deadline)
  )
    throw new Error("workspace.conflict: expired_lease");
}
