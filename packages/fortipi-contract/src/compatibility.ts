import { knownEventTypes } from "./generated/schemas.js";
import type {
  AssignmentDigestInput,
  ClientEvent,
  CommitDigestInput,
  InfrastructurePolicy,
  LocalScope,
  Manifest,
  OperationDigestInput,
  TransferDescriptor,
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
export type DigestDomain = "manifest" | "operation" | "assignment" | "commit";
export async function digestJson(domain: DigestDomain, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`fortipi:${domain}:v1\n${canonicalJson(value)}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}
export const operationDigest = (input: OperationDigestInput): Promise<string> =>
  digestJson("operation", input);
export const assignmentDigest = (input: AssignmentDigestInput): Promise<string> =>
  digestJson("assignment", input);
export const commitDigest = (input: CommitDigestInput): Promise<string> =>
  digestJson("commit", input);
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
    /[\\:]/u.test(path) ||
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
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(s)
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
  if (manifest.version !== 1 || manifest.entries.length > 4096) throw new Error("manifest limit");
  if (new TextEncoder().encode(canonicalJson(manifest)).length > 524288)
    throw new Error("manifest bytes");
  let bytes = 0;
  for (const entry of manifest.entries) {
    validateRelativePath(entry.path);
    const key = caseBehavior === "insensitive" ? entry.path.toLowerCase() : entry.path;
    if (paths.has(key)) throw new Error("path collision");
    paths.set(key, entry.type);
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
  if (!descriptor.consumer.workspaceIds.includes(descriptor.workspaceId))
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
