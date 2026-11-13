import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { assetPath } from "../packages/fortipi-cli/src/asset-manifest.ts";
import { canonicalJson } from "../packages/fortipi-contract/dist/index.js";
import { readArtifactZip } from "./artifact-zip.ts";
import { repository } from "./build-workspaces.ts";
import { cloudflareAccessChecks, npmAccessChecks } from "./check-access.ts";
import {
  assertOperatorConfirmedFreePlan,
  type OperatorConfirmedFreePlan,
} from "./operator-free-plan.ts";

export { canonicalJson };
export const REPOSITORY = "scottdraper8/fortipi";
export const REPOSITORY_ID = 1453249080;
export const SYNTHETIC_SCOPE = "fortipi-ci-test";
export const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
export const sha512 = (data: Uint8Array) =>
  `sha512-${createHash("sha512").update(data).digest("base64")}`;
export const hashPattern = /^[a-f0-9]{64}$/;
export const commitPattern = /^[a-f0-9]{40}$/;
export const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
export const packageOrder = ["contract", "client", "tui", "cli", "executor"] as const;
export interface FileRecord {
  path: string;
  size: number;
  mode: number;
  sha256: string;
}
export interface Producer {
  workflowPath: string;
  workflowSha256: string;
  workflowId: number;
  runId: number;
  runAttempt: number;
}
export interface CandidatePackage {
  name: string;
  sourceName: string;
  version: string;
  tarball: string;
  sha256: string;
  integrity: string;
  entries: FileRecord[];
}
export interface CandidateManifest {
  schemaVersion: 1;
  repository: typeof REPOSITORY;
  repositoryId: typeof REPOSITORY_ID;
  branch: "main";
  sourceCommit: string;
  version: string;
  tag: string;
  scope: string;
  publishable: boolean;
  createdAt: string;
  producer: Producer;
  hashes: { publishNames: string; lock: string; toolchainPolicy: string };
  assetManifestSha256: string;
  image: {
    sourceCommit: string;
    metadataSha256: string;
    imageId: string;
    builtManifestDigest: string;
    sourceKitSha256: string;
  };
  packages: CandidatePackage[];
  files: FileRecord[];
}
export interface ArtifactReference {
  runId: number;
  runAttempt: number;
  artifactId: number;
  artifactName: string;
  artifactDigest: string;
  candidateSha256: string;
}
export interface DeploymentIdentity {
  schemaVersion: 1;
  candidateSha256: string;
  sourceCommit: string;
  accountBindingSha256: string;
  slot: "production" | "paid-validation";
  workerName: string;
  origin: string;
  workerVersionId: string;
  deploymentId: string;
  versions: { versionId: string; percentage: number }[];
  configSha256: string;
  runtimeConfigSha256: string;
  assetManifestSha256: string;
  publicConfigurationVersion: number;
  planProvenance?: OperatorConfirmedFreePlan;
  capabilities: { plan: "unknown" | "free" | "paid"; loaders: boolean; containers: boolean };
  backend: "free" | "cloud-js" | "linux";
  imageDigest: string | null;
  checkedAt: string;
}
export type GateKind =
  | "candidate"
  | "integrated"
  | "native"
  | "access"
  | "cloudflare-access"
  | "live"
  | "independent"
  | "readiness";
/** Detailed ClaimResult remains owner10's type. These are hashes of its sanitized saved results. */
export interface GateReceipt {
  schemaVersion: 1;
  kind: GateKind;
  candidateSha256: string;
  sourceCommit: string;
  scope: string;
  producer: Producer;
  checkedAt: string;
  claims: { id: string; outcome: "pass"; result: FileRecord }[];
  platforms: ("linux" | "darwin" | "win32")[];
  deployments: DeploymentIdentity[];
  files: FileRecord[];
}
export const requiredClaims = [
  "admission-durability",
  "pi-lifecycle",
  "application-replay",
  "replay-live-race",
  "ticket-grants-revoke",
  "workspace-atomicity",
  "fence-generation",
  "dispatch-safety",
  "approval-reconcile",
  "portable-daemon",
  "cloud-local-portability",
  "real-cloud-tools",
  "models-security",
  "distribution-install",
  "public-clients",
  "supply-chain",
  "sealed-store-retirement",
  "local-apply-receipt",
  "scoped-relay",
  "infrastructure-boundaries",
  "image-security",
  "compatibility-review",
] as const;
export const integratedClaims = requiredClaims.filter(
  (id) =>
    ![
      "portable-daemon",
      "cloud-local-portability",
      "real-cloud-tools",
      "models-security",
      "public-clients",
    ].includes(id),
);
export const liveClaims = [
  "pi-lifecycle",
  "ticket-grants-revoke",
  "workspace-atomicity",
  "fence-generation",
  "dispatch-safety",
  "approval-reconcile",
  "cloud-local-portability",
  "real-cloud-tools",
  "models-security",
  "public-clients",
  "infrastructure-boundaries",
] as const;
const deploymentJobs = [
  "initial-installed-deployment",
  "live-device-a",
  "live-device-b",
  "live-device-cleanup",
  "operate",
];
const policy: Record<GateKind, { workflow: string; jobs: string[]; hours: number }> = {
  candidate: { workflow: "release.yml", jobs: ["candidate"], hours: 24 },
  integrated: { workflow: "ci.yml", jobs: ["policy-and-integration"], hours: 24 },
  native: {
    workflow: "release.yml",
    jobs: ["native (ubuntu-24.04)", "native (macos-15)", "native (windows-2025)", "native-receipt"],
    hours: 24,
  },
  access: { workflow: "access-preflight.yml", jobs: ["cloudflare", "npm"], hours: 24 },
  "cloudflare-access": { workflow: "access-preflight.yml", jobs: ["cloudflare"], hours: 24 },
  live: {
    workflow: "deploy.yml",
    jobs: deploymentJobs,
    hours: 6,
  },
  independent: {
    workflow: "deploy.yml",
    jobs: deploymentJobs,
    hours: 6,
  },
  readiness: { workflow: "deploy.yml", jobs: ["operate"], hours: 0.25 },
};
export function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Expected object");
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, keys: string[]): void {
  assert.ok(
    Object.keys(value).every((key) => keys.includes(key)),
    "Unexpected receipt field",
  );
}
export function string(value: unknown, maximum = 1024): string {
  assert.ok(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum &&
      [...value].every((character) => character.charCodeAt(0) >= 32),
    "Invalid string",
  );
  return value;
}
export function integer(value: unknown): number {
  assert.ok(Number.isSafeInteger(value) && Number(value) > 0, "Invalid positive identity");
  return Number(value);
}
export function digest(value: unknown): string {
  const text = string(value);
  assert.match(text, hashPattern);
  return text;
}
export function safePath(path: string): string {
  assert.ok(
    assetPath(path) &&
      !/(^|\/)(?:\.env[^/]*|\.npmrc|auth\.json|credentials(?:\.json)?|node_modules|\.git|\.wrangler)(?:\/|$)/i.test(
        path,
      ),
    "Unsafe artifact path",
  );
  return path;
}
/** Metadata shape only. Actual bundled bytes require independently authenticated authority. */
export function packageEntryPath(path: string): string {
  if (!path.startsWith("node_modules/")) return safePath(path);
  assert.ok(assetPath(path), "Unsafe package entry path");
  assert.ok(
    !/\.(?:node(?:\.wasm)?|dylib|dll|so(?:\.\d+)*|exe)$/i.test(path),
    "Native dependency entry rejected",
  );
  const code =
    /(?:^|\/)node_modules\/@anthropic-ai\/sdk\/(?:src\/)?lib\/credentials\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]s|[cm]?[jt]s\.map)$/.test(
      path,
    );
  const shape = path.replace(/(^|\/)node_modules\//g, "$1");
  safePath(
    code
      ? shape.replace(
          /(^|\/)@anthropic-ai\/sdk\/((?:src\/)?lib)\/credentials\//g,
          "$1@anthropic-ai/sdk/$2/reviewed-code/",
        )
      : shape,
  );
  return path;
}
export function freshness(time: string, hours: number, now = Date.now()): void {
  const age = now - Date.parse(time);
  assert.ok(
    Number.isFinite(age) && age >= -60_000 && age <= hours * 3600_000,
    "Stale/future proof",
  );
}
export async function regularBytes(path: string, maximum?: number): Promise<Buffer> {
  let parent = dirname(resolve(path));
  while (true) {
    const stat = await lstat(parent);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Linked artifact parent");
    if (dirname(parent) === parent) break;
    parent = dirname(parent);
  }
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "Nonregular artifact");
  if (maximum === undefined) return readFile(path);
  assert.ok(Number.isSafeInteger(maximum) && maximum >= 0);
  assert.ok(stat.size <= maximum, "Artifact byte bound");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    assert.ok(
      current.isFile() &&
        current.nlink === 1 &&
        current.ino === stat.ino &&
        current.dev === stat.dev,
      "Artifact changed during open",
    );
    assert.ok(current.size <= maximum, "Artifact byte bound");
    const buffer = Buffer.alloc(Math.min(256 * 1024, maximum + 1));
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, maximum - size + 1),
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
      assert.ok(size <= maximum, "Artifact byte bound");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
}
export async function readJson(path: string): Promise<unknown> {
  return JSON.parse((await regularBytes(path)).toString("utf8"));
}
export async function saveJson(path: string, value: unknown, exclusive = true): Promise<string> {
  const data = `${canonicalJson(value)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!exclusive) {
    try {
      await rename(target, path);
    } finally {
      await rm(target, { force: true });
    }
  }
  if (process.platform !== "win32") {
    const parent = await open(dirname(path), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  return sha256(data);
}
export async function inventory(
  root: string,
  prefix = "",
  bounds?: ReadonlyMap<string, number>,
): Promise<FileRecord[]> {
  const result: FileRecord[] = [];
  const rootStat = await lstat(root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "Linked artifact directory");
  for (const item of (await readdir(root)).sort()) {
    const path = safePath(prefix ? `${prefix}/${item}` : item);
    const absolute = resolve(root, item);
    const stat = await lstat(absolute);
    assert.ok(!stat.isSymbolicLink(), "Linked artifact entry");
    if (stat.isDirectory()) result.push(...(await inventory(absolute, path, bounds)));
    else {
      if (bounds) assert.ok(bounds.has(path), "Artifact payload differs from retained inventory");
      result.push({
        path,
        mode: stat.mode & 0o777,
        size: stat.size,
        sha256: sha256(await regularBytes(absolute, bounds?.get(path))),
      });
    }
  }
  assert.equal(
    new Set(result.map((file) => file.path.toLowerCase())).size,
    result.length,
    "Artifact path collision",
  );
  return result.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
export function records(
  value: unknown,
  pathShape: (path: string) => string = safePath,
): asserts value is FileRecord[] {
  assert.ok(
    Array.isArray(value) && value.length > 0 && value.length < 30000,
    "Missing artifact inventory",
  );
  const seen = new Set<string>();
  for (const row of value) {
    const f = object(row);
    closed(f, ["path", "size", "mode", "sha256"]);
    const path = pathShape(string(f.path));
    assert.ok(!seen.has(path.toLowerCase()), "Duplicate artifact path");
    seen.add(path.toLowerCase());
    digest(f.sha256);
    assert.ok(
      Number.isSafeInteger(f.size) &&
        Number(f.size) >= 0 &&
        Number.isSafeInteger(f.mode) &&
        Number(f.mode) >= 0 &&
        Number(f.mode) <= 0o777,
      "Invalid artifact size/mode",
    );
  }
}
export function assertCandidate(value: unknown): asserts value is CandidateManifest {
  const c = object(value);
  closed(c, [
    "schemaVersion",
    "repository",
    "repositoryId",
    "branch",
    "sourceCommit",
    "version",
    "tag",
    "scope",
    "publishable",
    "createdAt",
    "producer",
    "hashes",
    "assetManifestSha256",
    "image",
    "packages",
    "files",
  ]);
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.repository, REPOSITORY);
  assert.equal(c.repositoryId, REPOSITORY_ID);
  assert.equal(c.branch, "main");
  assert.match(string(c.sourceCommit), commitPattern);
  assert.match(string(c.version), versionPattern);
  assert.equal(c.tag, `v${c.version}`);
  assert.match(string(c.scope), /^[a-z0-9][a-z0-9._-]*$/);
  assert.equal(c.publishable, c.scope !== SYNTHETIC_SCOPE);
  assert.ok(Number.isFinite(Date.parse(string(c.createdAt))));
  for (const field of ["publishNames", "lock", "toolchainPolicy"]) digest(object(c.hashes)[field]);
  digest(c.assetManifestSha256);
  const image = object(c.image);
  assert.match(string(image.sourceCommit), commitPattern);
  for (const key of ["metadataSha256", "sourceKitSha256"]) digest(image[key]);
  for (const key of ["imageId", "builtManifestDigest"])
    assert.match(string(image[key]), /^sha256:[a-f0-9]{64}$/);
  assertProducer(c.producer, c.publishable === true);
  assert.ok(Array.isArray(c.packages) && c.packages.length === 5);
  assert.deepEqual(
    c.packages.map((p) => object(p).sourceName).sort(),
    packageOrder.map((name) => `fortipi-${name}`).sort(),
  );
  for (const row of c.packages) {
    const p = object(row);
    assert.equal(p.name, `@${c.scope}/${p.sourceName}`);
    assert.equal(p.version, c.version);
    safePath(string(p.tarball));
    digest(p.sha256);
    assert.match(string(p.integrity), /^sha512-[A-Za-z0-9+/]{86}==$/);
    records(p.entries, packageEntryPath);
  }
  records(c.files);
  const all = c.files as FileRecord[];
  for (const row of c.packages) {
    const p = object(row);
    assert.ok(
      all.some((f) => f.path === p.tarball && f.sha256 === p.sha256),
      "Uninventoried tarball",
    );
  }
  assert.ok(
    all.some((f) => f.path === "sbom.json") &&
      all.some((f) => f.path === "image/sources-and-notices.tar"),
    "Missing SBOM/source delivery",
  );
}
export function assertProducer(value: unknown, trusted = true): asserts value is Producer {
  const p = object(value);
  closed(p, ["workflowPath", "workflowSha256", "workflowId", "runId", "runAttempt"]);
  assert.match(string(p.workflowPath), /^\.github\/workflows\/[a-z-]+\.yml$/);
  digest(p.workflowSha256);
  for (const key of ["workflowId", "runId", "runAttempt"])
    if (trusted) integer(p[key]);
    else assert.ok(Number.isSafeInteger(p[key]) && Number(p[key]) >= 0);
}
export function assertDeployment(value: unknown): asserts value is DeploymentIdentity {
  const d = object(value);
  closed(d, [
    "schemaVersion",
    "candidateSha256",
    "sourceCommit",
    "accountBindingSha256",
    "slot",
    "workerName",
    "origin",
    "workerVersionId",
    "deploymentId",
    "versions",
    "configSha256",
    "runtimeConfigSha256",
    "assetManifestSha256",
    "publicConfigurationVersion",
    "capabilities",
    "backend",
    "imageDigest",
    "checkedAt",
    ...(Object.hasOwn(d, "planProvenance") ? ["planProvenance"] : []),
  ]);
  assert.equal(d.schemaVersion, 1);
  digest(d.candidateSha256);
  assert.match(string(d.sourceCommit), commitPattern);
  digest(d.accountBindingSha256);
  assert.ok(d.slot === "production" || d.slot === "paid-validation");
  assert.match(string(d.workerName), /^[a-z0-9][a-z0-9-]{0,62}$/);
  assert.match(string(d.origin), /^https:\/\/[a-z0-9.-]+(?::443)?$/);
  for (const key of ["workerVersionId", "deploymentId"])
    assert.match(string(d[key]), /^[a-f0-9-]{36}$/);
  assert.deepEqual(
    d.versions,
    [{ versionId: d.workerVersionId, percentage: 100 }],
    "Nonexclusive rollout",
  );
  for (const key of ["configSha256", "runtimeConfigSha256", "assetManifestSha256"]) digest(d[key]);
  assert.ok(
    Number.isSafeInteger(d.publicConfigurationVersion) && Number(d.publicConfigurationVersion) >= 0,
  );
  const cap = object(d.capabilities);
  assert.ok(cap.plan === "unknown" || cap.plan === "free" || cap.plan === "paid");
  assert.equal(typeof cap.loaders, "boolean");
  assert.equal(typeof cap.containers, "boolean");
  if (Object.hasOwn(d, "planProvenance")) {
    assert.equal(cap.plan, "free");
    assertOperatorConfirmedFreePlan(d.planProvenance, string(d.accountBindingSha256));
  }
  assert.ok(["free", "cloud-js", "linux"].includes(string(d.backend)));
  if (d.backend === "free") {
    assert.equal(cap.loaders, false);
    assert.equal(cap.containers, false);
    assert.equal(d.imageDigest, null);
  } else {
    assert.equal(cap.plan, "paid");
    assert.equal(cap.loaders, d.backend === "cloud-js");
    assert.equal(cap.containers, d.backend === "linux");
  }
  if (d.backend === "linux") assert.match(string(d.imageDigest), /^sha256:[a-f0-9]{64}$/);
  else assert.equal(d.imageDigest, null);
  string(d.checkedAt);
}
/** Complements authenticated provider/workload evidence; config-only Free is insufficient. */
export function assertActualFreeDeployment(value: DeploymentIdentity): void {
  assertDeployment(value);
  assert.equal(value.backend, "free");
  assert.equal(value.capabilities.plan, "free", "Actual Free target proof remains required");
  assertOperatorConfirmedFreePlan(value.planProvenance, value.accountBindingSha256);
}
export function assertGate(value: unknown): asserts value is GateReceipt {
  assertGateShape(value, true);
}
/** Local observations cannot enter any privileged gate reader. */
export function assertSyntheticLocalGate(
  value: unknown,
  candidate: CandidateManifest,
  mode: "local" | "native" | "live",
): asserts value is GateReceipt {
  assertCandidate(candidate);
  assert.equal(mode, "local");
  assert.notEqual(process.env.GITHUB_ACTIONS, "true");
  assert.equal(candidate.publishable, false);
  assert.equal(candidate.scope, SYNTHETIC_SCOPE);
  assertGateShape(value, false);
  assert.equal(value.kind, "integrated");
  assert.equal(value.sourceCommit, candidate.sourceCommit);
  assert.equal(value.scope, candidate.scope);
  for (const id of [value.producer.workflowId, value.producer.runId, value.producer.runAttempt])
    assert.equal(id, 0);
}
function assertGateShape(value: unknown, trusted: boolean): asserts value is GateReceipt {
  const g = object(value);
  closed(g, [
    "schemaVersion",
    "kind",
    "candidateSha256",
    "sourceCommit",
    "scope",
    "producer",
    "checkedAt",
    "claims",
    "platforms",
    "deployments",
    "files",
  ]);
  assert.equal(g.schemaVersion, 1);
  assert.ok(Object.hasOwn(policy, string(g.kind)));
  digest(g.candidateSha256);
  assert.match(string(g.sourceCommit), commitPattern);
  string(g.scope);
  string(g.checkedAt);
  assertProducer(g.producer, trusted);
  records(g.files);
  assert.ok(Array.isArray(g.claims) && g.claims.length > 0);
  const ids = new Set();
  for (const row of g.claims) {
    const claim = object(row);
    closed(claim, ["id", "outcome", "result"]);
    assert.ok(!ids.has(string(claim.id)));
    ids.add(claim.id);
    assert.equal(claim.outcome, "pass", "Required claim did not pass");
    records([claim.result]);
    assert.ok(
      (g.files as FileRecord[]).some((f) => canonicalJson(f) === canonicalJson(claim.result)),
      "Uninventoried claim result",
    );
  }
  assert.ok(
    Array.isArray(g.platforms) &&
      g.platforms.every((p) => ["linux", "darwin", "win32"].includes(p)),
  );
  assert.ok(Array.isArray(g.deployments));
  g.deployments.forEach(assertDeployment);
}
export async function verifyPayload(
  root: string,
  expected: FileRecord[],
  exclude: string[] = [],
): Promise<void> {
  const bounds = new Map(expected.map((file) => [file.path, file.size]));
  for (const path of exclude) bounds.set(path, 8_000_000);
  const actual = (await inventory(root, "", bounds)).filter((file) => !exclude.includes(file.path));
  assert.ok(
    actual.every((file) => (file.mode & 0o022) === 0),
    "Writable artifact payload",
  );
  // GitHub ZIP transport normalizes filesystem modes. Tar-entry modes remain independently exact.
  const bytes = (file: FileRecord) => ({ path: file.path, size: file.size, sha256: file.sha256 });
  assert.deepEqual(
    actual.map(bytes),
    [...expected].sort((a, b) => a.path.localeCompare(b.path, "en")).map(bytes),
    "Artifact payload differs from retained inventory",
  );
}
export type GitHubRequest = ((
  path: string,
  method?: "GET" | "POST" | "PATCH",
  body?: unknown,
) => Promise<unknown>) & {
  verifyArtifact: (artifact: ArtifactReference, member?: string) => Promise<Buffer | undefined>;
};
/** Trusted setup only: exact finite members from one digest-checked archive.
 * This transport conveys bytes, never producer/job or candidate authority. */
export type BoundedGitHubRequest = GitHubRequest & {
  verifyArtifactMembers(
    artifact: ArtifactReference,
    bounds: Readonly<Record<string, number>>,
  ): Promise<{ names: readonly string[]; members: Readonly<Record<string, Buffer>> }>;
};
export async function remoteHash(
  url: string,
  headers: Record<string, string>,
  transport: typeof fetch = fetch,
  destination?: string,
  maximumBytes = 1_500_000_000,
): Promise<string> {
  assert.ok(
    Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 1_500_000_000,
  );
  let response = await transport(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(60000),
  });
  if (response.status === 302) {
    const location = new URL(string(response.headers.get("location"), 8192));
    assert.equal(location.protocol, "https:");
    assert.ok(
      ["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
        location.hostname,
      ) ||
        location.hostname.endsWith(".blob.core.windows.net") ||
        location.hostname.endsWith(".actions.githubusercontent.com"),
      "Unexpected artifact download origin",
    );
    response = await transport(location, {
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    });
  }
  assert.equal(response.status, 200, "Artifact download unavailable");
  assert.ok(response.body);
  let size = 0;
  const hash = createHash("sha256");
  const output = destination ? await open(destination, "wx", 0o600) : undefined;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= maximumBytes, "Artifact download byte bound");
      hash.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    if (output) await output.sync();
  } finally {
    await output?.close();
  }
  return hash.digest("hex");
}
/** Fixed API origin; bounded responses and errors never include bodies or authorization material. */
export function githubRequest(
  token: string | undefined,
  transport: typeof fetch = fetch,
): BoundedGitHubRequest {
  let count = 0;
  const request: BoundedGitHubRequest = Object.assign(
    async (path: string, method: "GET" | "POST" | "PATCH" = "GET", body?: unknown) => {
      assert.ok(
        path.startsWith(`/repos/${REPOSITORY}`) && !path.includes("..") && ++count <= 256,
        "GitHub request boundary",
      );
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await transport(`https://api.github.com${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
      assert.ok(response.ok, `GitHub HTTP ${response.status}`);
      const data = await response.text();
      assert.ok(Buffer.byteLength(data) <= 4_000_000, "GitHub response bound");
      return JSON.parse(data);
    },
    {
      verifyArtifactMembers: async (
        artifact: ArtifactReference,
        bounds: Readonly<Record<string, number>>,
      ) => {
        const artifactId = integer(artifact.artifactId);
        const expectedDigest = artifact.artifactDigest;
        assert.match(expectedDigest, /^sha256:[a-f0-9]{64}$/);
        assert.ok(bounds && [Object.prototype, null].includes(Object.getPrototypeOf(bounds)));
        const entries = Object.entries(Object.getOwnPropertyDescriptors(bounds));
        assert.equal(Reflect.ownKeys(bounds).length, entries.length);
        assert.ok(entries.length > 0 && entries.length <= 16);
        let total = 0;
        for (const [name, descriptor] of entries) {
          safePath(name);
          assert.ok("value" in descriptor && Number.isSafeInteger(descriptor.value));
          assert.ok(descriptor.value > 0 && descriptor.value <= 8_000_000);
          total += descriptor.value;
        }
        assert.ok(total <= 8_000_000, "Finite artifact member byte bound");
        const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const directory = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-artifact-"));
        try {
          const path = resolve(directory, "artifact.zip");
          assert.equal(
            `sha256:${await remoteHash(`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifactId}/zip`, headers, transport, path, total + 65_536)}`,
            expectedDigest,
            "GitHub archive digest mismatch",
          );
          const members: Record<string, Buffer> = Object.create(null);
          let names: string[] | undefined;
          for (const [name, descriptor] of entries) {
            const selected = await readArtifactZip(path, name);
            assert.deepEqual([...selected.names].sort(), entries.map(([key]) => key).sort());
            if (names) assert.deepEqual(selected.names, names);
            names = selected.names;
            assert.ok(selected.bytes.length > 0 && selected.bytes.length <= descriptor.value);
            members[name] = selected.bytes;
          }
          assert.ok(names);
          return { names, members };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      verifyArtifact: async (artifact: ArtifactReference, member?: string) => {
        integer(artifact.artifactId);
        const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const directory = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-artifact-"));
        try {
          const path = member ? resolve(directory, "artifact.zip") : undefined;
          assert.equal(
            `sha256:${await remoteHash(`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifact.artifactId}/zip`, headers, transport, path)}`,
            artifact.artifactDigest,
            "GitHub archive digest mismatch",
          );
          if (!member || !path) return undefined;
          const { names, bytes: data } = await readArtifactZip(path, safePath(member));
          for (const name of names) safePath(name);
          const metadata = object(JSON.parse(data.toString("utf8")));
          if (member === "candidate.json" || member === "gate.json") {
            records(metadata.files);
            assert.deepEqual(
              [...names].sort(),
              [member, ...metadata.files.map((file) => file.path)].sort(),
              "ZIP payload differs from saved inventory",
            );
          }
          if (member === "readiness.json")
            assert.deepEqual(names, ["readiness.json"], "Unexpected readiness payload");
          if (
            [
              "journal.json",
              "provenance.json",
              "verified-bundles.json",
              "registry-evidence-inventory.json",
            ].includes(member)
          )
            assert.ok(
              names.every(
                (name) =>
                  [
                    "journal.json",
                    "provenance.json",
                    "verified-bundles.json",
                    "registry-evidence-inventory.json",
                  ].includes(name) || name.startsWith("registry-evidence/"),
              ),
              "Unexpected publication payload",
            );
          return data;
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    },
  );
  return request;
}
export async function trustedMain(
  candidate: CandidateManifest,
  request: GitHubRequest,
): Promise<void> {
  assert.ok(
    candidate.publishable && candidate.scope !== SYNTHETIC_SCOPE,
    "Synthetic candidate is never privileged",
  );
  const repo = object(await request(`/repos/${REPOSITORY}`));
  assert.equal(repo.id, REPOSITORY_ID);
  assert.equal(repo.full_name, REPOSITORY);
  const main = object(await request(`/repos/${REPOSITORY}/git/ref/heads/main`));
  assert.equal(object(main.object).sha, candidate.sourceCommit, "Main advanced beyond candidate");
  const refs = await request(`/repos/${REPOSITORY}/git/matching-refs/tags/${candidate.tag}`);
  assert.ok(Array.isArray(refs));
  for (const value of refs.filter((ref) => object(ref).ref === `refs/tags/${candidate.tag}`)) {
    let target = object(object(value).object);
    if (target.type === "tag")
      target = object(
        object(await request(`/repos/${REPOSITORY}/git/tags/${string(target.sha)}`)).object,
      );
    assert.equal(target.type, "commit");
    assert.equal(target.sha, candidate.sourceCommit, "Existing tag conflicts");
  }
}
export async function verifyProducer(
  candidate: CandidateManifest,
  kind: GateKind,
  producer: Producer,
  artifact: ArtifactReference,
  request: GitHubRequest,
  now = Date.now(),
  expectedMetadataSha256?: string,
): Promise<void> {
  assertProducer(producer);
  const rule = policy[kind];
  assert.equal(producer.workflowPath, `.github/workflows/${rule.workflow}`);
  assert.equal(artifact.runId, producer.runId);
  assert.equal(artifact.runAttempt, producer.runAttempt);
  integer(artifact.artifactId);
  digest(artifact.candidateSha256);
  assert.match(artifact.artifactDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    artifact.artifactName,
    `${kind}-${candidate.sourceCommit}-${candidate.scope}-${producer.runId}-${producer.runAttempt}`,
  );
  const base = `/repos/${REPOSITORY}`;
  const workflow = object(await request(`${base}/actions/workflows/${producer.workflowId}`));
  assert.equal(workflow.id, producer.workflowId);
  assert.equal(workflow.path, producer.workflowPath);
  assert.equal(workflow.state, "active");
  const run = object(await request(`${base}/actions/runs/${producer.runId}`));
  const attempt = object(
    await request(`${base}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}`),
  );
  for (const value of [run, attempt]) {
    assert.equal(value.id, producer.runId);
    assert.equal(value.run_attempt, producer.runAttempt, "Superseded attempt");
    assert.equal(value.workflow_id, producer.workflowId);
    assert.equal(value.head_sha, candidate.sourceCommit);
    assert.equal(value.head_branch, "main");
    assert.ok(["push", "workflow_dispatch"].includes(string(value.event)));
    assert.equal(object(value.repository).id, REPOSITORY_ID);
    assert.equal(object(value.head_repository).id, REPOSITORY_ID);
    assert.equal(value.status, "completed");
    assert.equal(value.conclusion, "success");
    assert.equal(string(value.path).split("@")[0], producer.workflowPath);
    freshness(string(value.updated_at), rule.hours, now);
  }
  const content = object(
    await request(`${base}/contents/${producer.workflowPath}?ref=${candidate.sourceCommit}`),
  );
  assert.equal(content.encoding, "base64");
  assert.ok(typeof content.content === "string");
  assert.equal(
    sha256(Buffer.from(content.content.replaceAll("\n", ""), "base64")),
    producer.workflowSha256,
    "Workflow source mismatch",
  );
  const jobs: Record<string, unknown>[] = [];
  let total = Infinity;
  for (let page = 1; jobs.length < total; page++) {
    assert.ok(page <= 20, "Jobs pagination bound");
    const response = object(
      await request(
        `${base}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}/jobs?per_page=100&page=${page}`,
      ),
    );
    total = Number(response.total_count);
    assert.ok(Array.isArray(response.jobs) && response.jobs.length > 0);
    jobs.push(...response.jobs.map(object));
  }
  for (const name of rule.jobs) {
    const matching = jobs.filter((job) => job.name === name);
    assert.equal(matching.length, 1, "Missing/duplicate required job");
    assert.equal(matching[0]?.status, "completed");
    assert.equal(matching[0]?.conclusion, "success", "Skipped/failed required job");
  }
  const saved = object(await request(`${base}/actions/artifacts/${artifact.artifactId}`));
  const lineage = object(saved.workflow_run);
  assert.equal(saved.name, artifact.artifactName);
  assert.equal(saved.expired, false);
  assert.equal(saved.digest, artifact.artifactDigest);
  assert.equal(lineage.id, producer.runId);
  assert.equal(lineage.repository_id, REPOSITORY_ID);
  assert.equal(lineage.head_repository_id, REPOSITORY_ID);
  assert.equal(lineage.head_sha, candidate.sourceCommit);
  assert.equal(lineage.head_branch, "main");
  const start = Date.parse(string(attempt.run_started_at));
  const end = Date.parse(string(attempt.updated_at));
  const created = Date.parse(string(saved.created_at));
  assert.ok(created >= start && created <= end, "Artifact outside verified attempt window");
  assert.ok(Date.parse(string(saved.expires_at)) > now, "Expired artifact");
  assert.ok(
    jobs.some(
      (job) =>
        typeof job.started_at === "string" &&
        typeof job.completed_at === "string" &&
        created >= Date.parse(job.started_at) &&
        created <= Date.parse(job.completed_at),
    ),
    "Artifact not bound to attempt job window",
  );
  const metadata = await request.verifyArtifact(
    artifact,
    kind === "candidate" ? "candidate.json" : "gate.json",
  );
  assert.ok(metadata);
  if (kind === "candidate")
    assert.equal(
      sha256(metadata),
      artifact.candidateSha256,
      "Candidate bytes differ from actual producer archive",
    );
  else {
    assert.ok(expectedMetadataSha256, "Saved receipt hash required");
    assert.equal(
      sha256(metadata),
      expectedMetadataSha256,
      "Receipt bytes differ from actual producer archive",
    );
  }
}
export interface ProofInput {
  artifact: ArtifactReference;
  receipt: GateReceipt;
  directory: string;
}
export function assertAccessResult(
  value: unknown,
  kind: "cloudflare" | "npm",
  scope: string,
  now?: number,
): void {
  const result = object(value);
  const cf = kind === "cloudflare";
  closed(result, [
    "schemaVersion",
    "kind",
    "checkedAt",
    "checks",
    cf ? "accountBindingSha256" : "scope",
  ]);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.kind, kind);
  assert.deepEqual(result.checks, cf ? cloudflareAccessChecks : npmAccessChecks);
  freshness(string(result.checkedAt), 24, now);
  if (cf) digest(result.accountBindingSha256);
  else assert.equal(result.scope, scope, "npm scope differs from candidate");
}
/** Payload validation only. Callers must authenticate the original producer/archive first. */
export async function readAccessGate(
  proof: Pick<ProofInput, "receipt" | "directory">,
  candidate: CandidateManifest,
  now?: number,
): Promise<{ accountBindingSha256: string }> {
  const r = proof.receipt;
  assert.ok(r.kind === "access" || r.kind === "cloudflare-access");
  const expected = [
    ["cloudflare-read-access", "cloudflare.json"],
    ...(r.kind === "access" ? [["npm-read-access", "npm.json"]] : []),
  ];
  assert.deepEqual(r.platforms, []);
  assert.deepEqual(r.deployments, []);
  assert.deepEqual(r.claims.map((c) => c.id).sort(), expected.map(([id]) => id).sort());
  assert.deepEqual(r.files.map((f) => f.path).sort(), expected.map(([, path]) => path).sort());
  let accountBindingSha256 = "";
  let oldest = Infinity;
  for (const [id, path] of expected) {
    const claim = r.claims.find((c) => c.id === id);
    assert.ok(claim && path);
    assert.equal(claim.result.path, path);
    const bytes = await regularBytes(resolve(proof.directory, path), 8192);
    assert.equal(bytes.length, claim.result.size);
    assert.equal(sha256(bytes), claim.result.sha256, "Access result changed");
    const value = object(JSON.parse(bytes.toString("utf8")));
    assert.equal(bytes.toString("utf8"), `${canonicalJson(value)}\n`);
    const cf = id === "cloudflare-read-access";
    assertAccessResult(value, cf ? "cloudflare" : "npm", candidate.scope, now);
    oldest = Math.min(oldest, Date.parse(string(value.checkedAt)));
    if (cf) {
      digest(value.accountBindingSha256);
      accountBindingSha256 = string(value.accountBindingSha256);
    }
  }
  assert.equal(Date.parse(r.checkedAt), oldest, "Access receipt refreshed original observation");
  return { accountBindingSha256 };
}
export interface CurrentReadinessContext {
  directory: string;
  phase: "readiness" | "final-readiness";
}
export async function verifyReleaseGates(
  candidate: CandidateManifest,
  candidateHash: string,
  candidateArtifact: ArtifactReference,
  proofs: ProofInput[],
  request: GitHubRequest,
  now?: number,
  currentReadiness?: CurrentReadinessContext,
): Promise<void> {
  candidate = structuredClone(candidate);
  candidateArtifact = structuredClone(candidateArtifact);
  proofs = structuredClone(proofs);
  assertCandidate(candidate);
  digest(candidateHash);
  assert.equal(candidateArtifact.candidateSha256, candidateHash);
  await trustedMain(candidate, request);
  await verifyProducer(candidate, "candidate", candidate.producer, candidateArtifact, request, now);
  const kinds: GateKind[] = ["integrated", "native", "access", "live", "independent"];
  if (!currentReadiness) kinds.push("readiness");
  for (const kind of kinds) {
    const selected = proofs.filter((p) => p.receipt.kind === kind);
    const targets = ["live", "independent", "readiness"].includes(kind);
    assert.ok(
      targets ? selected.length > 0 && selected.length <= 3 : selected.length === 1,
      `Missing/duplicate ${kind} producer`,
    );
    for (const proof of selected) {
      const r = proof.receipt;
      assertGate(r);
      assert.equal(r.candidateSha256, candidateHash);
      assert.equal(proof.artifact.candidateSha256, candidateHash);
      assert.equal(r.sourceCommit, candidate.sourceCommit);
      assert.equal(r.scope, candidate.scope);
      freshness(r.checkedAt, policy[kind].hours, now);
      const gateBytes = await regularBytes(resolve(proof.directory, "gate.json"));
      if (kind === "access")
        assert.deepEqual(
          JSON.parse(gateBytes.toString("utf8")),
          r,
          "Access receipt object differs from saved bytes",
        );
      await verifyProducer(
        candidate,
        kind,
        r.producer,
        proof.artifact,
        request,
        now,
        sha256(gateBytes),
      );
      await verifyPayload(proof.directory, r.files, ["gate.json"]);
      if (kind === "access")
        await readAccessGate({ receipt: r, directory: proof.directory }, candidate, now);
      if (kind === "integrated" || kind === "live" || kind === "independent")
        for (const id of kind === "integrated"
          ? integratedClaims
          : liveClaims.filter(
              (claim) =>
                claim !== "real-cloud-tools" || r.deployments.some((d) => d.backend !== "free"),
            ))
          assert.ok(
            r.claims.some((c) => c.id === id),
            `Missing required claim: ${id}`,
          );
      if (kind === "native") {
        assert.deepEqual([...r.platforms].sort(), ["darwin", "linux", "win32"]);
        for (const platform of r.platforms)
          assert.ok(r.claims.some((c) => c.id === `portable-daemon-${platform}`));
      }
      if (["live", "independent", "readiness"].includes(kind)) {
        assert.ok(r.deployments.length > 0 && r.deployments.length <= 3);
        for (const d of r.deployments) {
          assert.equal(d.candidateSha256, candidateHash);
          assert.equal(d.sourceCommit, candidate.sourceCommit);
          assert.equal(d.assetManifestSha256, candidate.assetManifestSha256);
          if (d.backend === "linux") assert.ok(d.imageDigest, "Missing actual selected image");
          if (d.backend === "free") assertActualFreeDeployment(d);
        }
      }
    }
    if (targets)
      assert.deepEqual(
        selected
          .flatMap((p) => p.receipt.deployments)
          .map((d) => d.backend)
          .sort(),
        ["cloud-js", "free", "linux"],
        "Missing/duplicate required Free or paid target",
      );
  }
  const live = proofs.filter((p) => p.receipt.kind === "live");
  const independent = proofs.filter((p) => p.receipt.kind === "independent");
  const ready = proofs.filter((p) => p.receipt.kind === "readiness");
  for (const verification of independent)
    for (const d of verification.receipt.deployments) {
      const original = live.find((p) =>
        p.receipt.deployments.some((target) => target.backend === d.backend),
      );
      assert.ok(original);
      assert.notEqual(
        original.receipt.producer.runId,
        verification.receipt.producer.runId,
        "Independent verification requires a separate run",
      );
    }
  const stable = (items: DeploymentIdentity[]) =>
    items
      .map(({ checkedAt: _time, ...identity }) => identity)
      .sort((a, b) => a.backend.localeCompare(b.backend));
  assert.deepEqual(
    stable(live.flatMap((p) => p.receipt.deployments)),
    stable(independent.flatMap((p) => p.receipt.deployments)),
  );
  assert.deepEqual(
    stable(
      currentReadiness
        ? await verifyCurrentReadinessSet(
            candidate,
            candidateHash,
            proofs,
            currentReadiness,
            request,
            now,
          )
        : ready.flatMap((p) => p.receipt.deployments),
    ),
    stable(independent.flatMap((p) => p.receipt.deployments)),
    "Readiness target drift",
  );
  // Authorization must use the clock after all API, archive and filesystem awaits.
  const authorizedAt = now ?? Date.now();
  for (const proof of proofs)
    if (kinds.includes(proof.receipt.kind))
      freshness(proof.receipt.checkedAt, policy[proof.receipt.kind].hours, authorizedAt);
}
export function cliArgs(args = process.argv.slice(3)): Record<string, string> {
  assert.equal(args.length % 2, 0);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    assert.ok(typeof key === "string");
    assert.ok(
      key?.startsWith("--") &&
        value &&
        !value.startsWith("--") &&
        !Object.hasOwn(result, key.slice(2)),
      "Invalid/duplicate argument",
    );
    result[key.slice(2)] = value;
  }
  return result;
}
export async function verifyDeploymentGates(
  candidate: CandidateManifest,
  candidateHash: string,
  candidateArtifact: ArtifactReference,
  proofs: ProofInput[],
  request: GitHubRequest,
  targetAccountBindingSha256: string,
  now?: number,
): Promise<void> {
  candidate = structuredClone(candidate);
  candidateArtifact = structuredClone(candidateArtifact);
  proofs = structuredClone(proofs);
  assertCandidate(candidate);
  digest(candidateHash);
  assert.equal(candidateArtifact.candidateSha256, candidateHash);
  digest(targetAccountBindingSha256);
  const access = proofs.filter(
    (p) => p.receipt.kind === "access" || p.receipt.kind === "cloudflare-access",
  );
  assert.equal(access.length, 1, "Exactly one Cloudflare access prerequisite required");
  const accessKind = access[0]?.receipt.kind;
  assert.ok(accessKind === "access" || accessKind === "cloudflare-access");
  await trustedMain(candidate, request);
  await verifyProducer(candidate, "candidate", candidate.producer, candidateArtifact, request, now);
  const selected: GateReceipt[] = [];
  for (const kind of ["integrated", "native", accessKind] as const) {
    const matches = proofs.filter((p) => p.receipt.kind === kind);
    assert.equal(matches.length, 1, `Missing/duplicate ${kind} prerequisite`);
    const proof = matches[0];
    assert.ok(proof);
    const r = structuredClone(proof.receipt);
    assertGate(r);
    assert.equal(r.candidateSha256, candidateHash);
    assert.equal(proof.artifact.candidateSha256, candidateHash);
    assert.equal(r.sourceCommit, candidate.sourceCommit);
    assert.equal(r.scope, candidate.scope);
    freshness(r.checkedAt, 24, now);
    const gateBytes = await regularBytes(resolve(proof.directory, "gate.json"));
    assert.deepEqual(
      JSON.parse(gateBytes.toString("utf8")),
      r,
      "Receipt object differs from saved bytes",
    );
    await verifyProducer(
      candidate,
      kind,
      r.producer,
      proof.artifact,
      request,
      now,
      sha256(gateBytes),
    );
    await verifyPayload(proof.directory, r.files, ["gate.json"]);
    assert.equal(
      sha256(await regularBytes(resolve(proof.directory, "gate.json"))),
      sha256(gateBytes),
    );
    if (kind === "access" || kind === "cloudflare-access") {
      const result = await readAccessGate({ ...proof, receipt: r }, candidate, now);
      assert.equal(
        result.accountBindingSha256,
        targetAccountBindingSha256,
        "Cloudflare access account differs from target",
      );
    }
    if (kind === "integrated")
      for (const id of integratedClaims)
        assert.ok(
          r.claims.some((c) => c.id === id),
          `Missing ${id}`,
        );
    if (kind === "native") {
      assert.deepEqual([...r.platforms].sort(), ["darwin", "linux", "win32"]);
      for (const platform of r.platforms)
        assert.ok(r.claims.some((c) => c.id === `portable-daemon-${platform}`));
    }
    selected.push(r);
  }
  await trustedMain(candidate, request);
  for (const r of selected) freshness(r.checkedAt, 24, now ?? Date.now());
}
export async function git(...args: string[]): Promise<string> {
  return (
    await promisify(execFile)("git", args, {
      cwd: repository,
      env: {
        PATH: process.env.PATH,
        Path: process.env.Path,
        SystemRoot: process.env.SystemRoot,
        LANG: "C",
      },
      timeout: 20000,
      maxBuffer: 2_000_000,
    })
  ).stdout.trim();
}
export async function privilegedCheckout(candidate: CandidateManifest): Promise<void> {
  assertCandidate(candidate);
  assert.ok(candidate.publishable && candidate.scope !== SYNTHETIC_SCOPE);
  assert.equal(await git("rev-parse", "HEAD"), candidate.sourceCommit);
  assert.equal(await git("status", "--porcelain"), "", "Dirty privileged source");
}
export async function assembleProofs(
  root: string,
  candidateArtifact: ArtifactReference,
  out: string,
): Promise<void> {
  const proofs: { artifact: ArtifactReference; directory: string }[] = [];
  for (const entry of await readdir(root)) {
    const directory = resolve(root, safePath(entry));
    const reference = object(await readJson(resolve(directory, "reference.json")));
    proofs.push({
      artifact: object(reference.artifact) as unknown as ArtifactReference,
      directory: resolve(directory, "payload"),
    });
  }
  await saveJson(out, { schemaVersion: 1, candidateArtifact, proofs });
}
export async function readProofBundle(
  path: string,
): Promise<{ candidateArtifact: ArtifactReference; proofs: ProofInput[] }> {
  const data = object(await readJson(path));
  assert.equal(data.schemaVersion, 1);
  assert.ok(Array.isArray(data.proofs));
  const proofs: ProofInput[] = [];
  for (const item of data.proofs) {
    const row = object(item);
    const directory = resolve(string(row.directory));
    const receipt = await readJson(resolve(directory, "gate.json"));
    assertGate(receipt);
    proofs.push({
      artifact: object(row.artifact) as unknown as ArtifactReference,
      receipt,
      directory,
    });
  }
  return {
    candidateArtifact: object(data.candidateArtifact) as unknown as ArtifactReference,
    proofs,
  };
}
interface CurrentReadinessObservation {
  checkedAt: string;
  expiresAt: number;
  deployments: DeploymentIdentity[];
}
function currentReadinessFreshness(observation: CurrentReadinessObservation, now: number): void {
  assert.ok(observation.expiresAt > now, "Current readiness artifact expired");
  freshness(observation.checkedAt, 0.25, now);
  for (const deployment of observation.deployments) freshness(deployment.checkedAt, 0.25, now);
}
/** Current jobs use completed `needs` facts; they never certify their own future run conclusion. */
async function currentReadinessObservation(
  candidate: CandidateManifest,
  candidateHash: string,
  path: string,
  artifact: ArtifactReference,
  request: GitHubRequest,
  jobName: "readiness" | "final-readiness",
): Promise<CurrentReadinessObservation> {
  assertCandidate(candidate);
  await trustedMain(candidate, request);
  integer(artifact.runId);
  integer(artifact.runAttempt);
  integer(artifact.artifactId);
  assert.equal(artifact.candidateSha256, candidateHash);
  assert.equal(artifact.runId, Number(process.env.GITHUB_RUN_ID));
  assert.equal(artifact.runAttempt, Number(process.env.GITHUB_RUN_ATTEMPT));
  const prefix = jobName === "readiness" ? "refresh" : "final-refresh";
  const local = object(await readJson(path));
  assert.ok(Array.isArray(local.deployments) && local.deployments.length === 1);
  const backend = string(object(local.deployments[0]).backend);
  assert.ok(["free", "cloud-js", "linux"].includes(backend));
  assert.equal(
    artifact.artifactName,
    `${prefix}-${backend}-${candidate.sourceCommit}-${candidate.scope}-${artifact.runId}-${artifact.runAttempt}`,
  );
  const base = `/repos/${REPOSITORY}`;
  const run = object(await request(`${base}/actions/runs/${artifact.runId}`));
  const attempt = object(
    await request(`${base}/actions/runs/${artifact.runId}/attempts/${artifact.runAttempt}`),
  );
  for (const r of [run, attempt]) {
    assert.equal(r.id, artifact.runId);
    assert.equal(r.head_sha, candidate.sourceCommit);
    assert.equal(r.head_branch, "main");
    assert.equal(r.run_attempt, artifact.runAttempt);
    assert.equal(r.workflow_id, candidate.producer.workflowId);
    assert.equal(r.event, "workflow_dispatch");
    assert.equal(string(r.path).split("@")[0], ".github/workflows/release.yml");
    assert.equal(object(r.repository).id, REPOSITORY_ID);
    assert.equal(object(r.head_repository).id, REPOSITORY_ID);
    assert.ok(["in_progress", "completed"].includes(string(r.status)));
    if (r.status === "completed") assert.equal(r.conclusion, "success");
  }
  const workflow = object(
    await request(`${base}/contents/.github/workflows/release.yml?ref=${candidate.sourceCommit}`),
  );
  assert.equal(workflow.encoding, "base64");
  assert.equal(
    sha256(Buffer.from(string(workflow.content, 4_000_000).replaceAll("\n", ""), "base64")),
    candidate.producer.workflowSha256,
    "Current readiness workflow bytes differ",
  );
  const jobs: Record<string, unknown>[] = [];
  let total = Infinity;
  for (let page = 1; jobs.length < total; page++) {
    assert.ok(page <= 20);
    const data = object(
      await request(
        `${base}/actions/runs/${artifact.runId}/attempts/${artifact.runAttempt}/jobs?per_page=100&page=${page}`,
      ),
    );
    assert.ok(Array.isArray(data.jobs) && data.jobs.length > 0);
    jobs.push(...data.jobs.map(object));
    total = Number(data.total_count);
  }
  const matching = jobs.filter((job) => job.name === `${jobName} (${backend})`);
  assert.equal(matching.length, 1);
  const job = matching[0];
  assert.ok(job);
  assert.equal(job.status, "completed");
  assert.equal(job.conclusion, "success");
  const saved = object(await request(`${base}/actions/artifacts/${artifact.artifactId}`));
  assert.equal(saved.name, artifact.artifactName);
  assert.equal(saved.expired, false);
  assert.equal(saved.digest, artifact.artifactDigest);
  const origin = object(saved.workflow_run);
  assert.equal(origin.id, artifact.runId);
  assert.equal(origin.head_sha, candidate.sourceCommit);
  assert.equal(origin.repository_id, REPOSITORY_ID);
  assert.equal(origin.head_repository_id, REPOSITORY_ID);
  assert.equal(origin.head_branch, "main");
  const created = Date.parse(string(saved.created_at));
  assert.ok(
    created >= Date.parse(string(job.started_at)) &&
      created <= Date.parse(string(job.completed_at)),
  );
  const expiresAt = Date.parse(string(saved.expires_at));
  const actual = await request.verifyArtifact(artifact, "readiness.json");
  assert.ok(actual);
  assert.equal(
    sha256(actual),
    sha256(await regularBytes(path)),
    "Readiness bytes differ from verified current producer",
  );
  const ready = object(JSON.parse(actual.toString("utf8")));
  closed(ready, ["schemaVersion", "candidateSha256", "sourceCommit", "checkedAt", "deployments"]);
  assert.equal(ready.schemaVersion, 1);
  assert.equal(ready.candidateSha256, candidateHash);
  assert.equal(ready.sourceCommit, candidate.sourceCommit);
  const checkedAt = string(ready.checkedAt);
  assert.ok(Array.isArray(ready.deployments));
  ready.deployments.forEach(assertDeployment);
  assert.deepEqual(
    ready.deployments.map((d) => object(d).backend),
    [backend],
  );
  for (const d of ready.deployments) {
    assert.equal(d.candidateSha256, candidateHash);
    assert.equal(d.sourceCommit, candidate.sourceCommit);
    assert.equal(d.assetManifestSha256, candidate.assetManifestSha256);
    if (d.backend === "free") assertActualFreeDeployment(d);
  }
  return { checkedAt, expiresAt, deployments: ready.deployments };
}
export async function verifyCurrentReadiness(
  candidate: CandidateManifest,
  candidateHash: string,
  path: string,
  artifact: ArtifactReference,
  request: GitHubRequest,
  jobName: "readiness" | "final-readiness",
  now?: number,
): Promise<DeploymentIdentity[]> {
  const observation = await currentReadinessObservation(
    candidate,
    candidateHash,
    path,
    artifact,
    request,
    jobName,
  );
  currentReadinessFreshness(observation, now ?? Date.now());
  return observation.deployments;
}
export async function verifyCurrentReadinessSet(
  candidate: CandidateManifest,
  hash: string,
  proofs: ProofInput[],
  context: CurrentReadinessContext,
  request: GitHubRequest,
  now?: number,
): Promise<DeploymentIdentity[]> {
  const run = integer(Number(process.env.GITHUB_RUN_ID));
  const attempt = integer(Number(process.env.GITHUB_RUN_ATTEMPT));
  const artifacts: Record<string, unknown>[] = [];
  let total = Infinity;
  for (let page = 1; artifacts.length < total; page++) {
    assert.ok(page <= 20);
    const data = object(
      await request(`/repos/${REPOSITORY}/actions/runs/${run}/artifacts?per_page=100&page=${page}`),
    );
    assert.ok(Array.isArray(data.artifacts) && data.artifacts.length > 0);
    artifacts.push(...data.artifacts.map(object));
    total = Number(data.total_count);
  }
  const prefix = context.phase === "readiness" ? "refresh" : "final-refresh";
  const observations: CurrentReadinessObservation[] = [];
  for (const backend of ["free", "cloud-js", "linux"]) {
    const name = `${prefix}-${backend}-${candidate.sourceCommit}-${candidate.scope}-${run}-${attempt}`;
    const matches = artifacts.filter((a) => a.name === name);
    assert.equal(matches.length, 1, `Missing/duplicate current ${backend} readiness artifact`);
    const artifact = matches[0];
    assert.ok(artifact);
    const ref: ArtifactReference = {
      runId: run,
      runAttempt: attempt,
      artifactId: integer(artifact.id),
      artifactName: name,
      artifactDigest: string(artifact.digest),
      candidateSha256: hash,
    };
    observations.push(
      await currentReadinessObservation(
        candidate,
        hash,
        resolve(context.directory, safePath(name), "readiness.json"),
        ref,
        request,
        context.phase,
      ),
    );
  }
  // Recheck every observation together after the final network await. A previous slot
  // may have expired while another archive or the protected-main identity was fetched.
  await trustedMain(candidate, request);
  const authorizedAt = now ?? Date.now();
  for (const observation of observations) currentReadinessFreshness(observation, authorizedAt);
  for (const proof of proofs)
    if (proof.receipt.kind !== "readiness")
      freshness(proof.receipt.checkedAt, policy[proof.receipt.kind].hours, authorizedAt);
  return observations.flatMap((observation) => observation.deployments);
}
export async function dispatchEnvironment(): Promise<void> {
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  const source = string(process.env.SOURCE_SHA);
  assert.match(source, commitPattern);
  assert.equal(source, process.env.GITHUB_SHA);
  assert.equal(await git("rev-parse", "HEAD"), source);
  assert.equal(process.env.EXPECTED_TAG, `v${string(process.env.RELEASE_VERSION)}`);
  assert.match(string(process.env.RELEASE_VERSION), versionPattern);
  assert.match(string(process.env.RELEASE_SCOPE), /^[a-z0-9][a-z0-9._-]*$/);
  const operation = string(process.env.OPERATION);
  assert.ok(["candidate", "publish", "deploy", "verify"].includes(operation));
  assert.equal(
    process.env.CONFIRM,
    `${operation} v${process.env.RELEASE_VERSION} ${source} ${process.env.RELEASE_SCOPE}`,
  );
  if (operation !== "candidate")
    assert.notEqual(
      process.env.RELEASE_SCOPE,
      SYNTHETIC_SCOPE,
      "Synthetic artifacts cannot authorize privileged work",
    );
}
if (import.meta.main) {
  const args = cliArgs();
  if (process.argv[2] === "verify" || process.argv[2] === "deployment") {
    const candidatePath = resolve(string(args.candidate));
    const candidate = await readJson(candidatePath);
    assertCandidate(candidate);
    const data = object(await readJson(resolve(string(args.proofs))));
    assert.ok(Array.isArray(data.proofs));
    const proofs: ProofInput[] = [];
    for (const item of data.proofs) {
      const p = object(item);
      const directory = resolve(string(p.directory));
      const receipt = await readJson(resolve(directory, "gate.json"));
      assertGate(receipt);
      proofs.push({
        artifact: object(p.artifact) as unknown as ArtifactReference,
        receipt,
        directory,
      });
    }
    const base = [
      candidate,
      sha256(await regularBytes(candidatePath)),
      object(data.candidateArtifact) as unknown as ArtifactReference,
      proofs,
      githubRequest(process.env.GITHUB_TOKEN),
    ] as const;
    if (process.argv[2] === "deployment")
      await verifyDeploymentGates(...base, string(args["account-binding-sha256"]));
    else {
      const phase = args.phase ?? "readiness";
      assert.ok(phase === "readiness" || phase === "final-readiness");
      await verifyReleaseGates(
        ...base,
        undefined,
        args.readiness ? { directory: resolve(args.readiness), phase } : undefined,
      );
    }
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        candidateSha256: sha256(await regularBytes(candidatePath)),
        verifiedAt: new Date().toISOString(),
      }),
    );
  } else if (process.argv[2] === "dispatch") await dispatchEnvironment();
  else if (process.argv[2] === "assemble")
    await assembleProofs(
      resolve(string(args.root)),
      object(JSON.parse(string(process.env.CANDIDATE_REFERENCE))) as unknown as ArtifactReference,
      resolve(string(args.out)),
    );
  else if (process.argv[2] === "transfer") {
    const c = await readJson(resolve(string(args.candidate)));
    assertCandidate(c);
    const reference = object(JSON.parse(string(process.env.PROOF_REFERENCE)));
    const receipt = await readJson(resolve(string(args.directory), "gate.json"));
    assertGate(receipt);
    assert.equal(receipt.kind, reference.kind);
    const artifact = object(reference.artifact) as unknown as ArtifactReference;
    assert.equal(
      artifact.candidateSha256,
      sha256(await regularBytes(resolve(string(args.candidate)))),
    );
    await trustedMain(c, githubRequest(process.env.GITHUB_TOKEN));
    await verifyProducer(
      c,
      receipt.kind,
      receipt.producer,
      artifact,
      githubRequest(process.env.GITHUB_TOKEN),
      Date.now(),
      sha256(await regularBytes(resolve(string(args.directory), "gate.json"))),
    );
    await verifyPayload(resolve(string(args.directory)), receipt.files, ["gate.json"]);
    await saveJson(resolve(string(args.out)), reference);
  } else throw new Error("Expected verify, dispatch, transfer or assemble");
}
