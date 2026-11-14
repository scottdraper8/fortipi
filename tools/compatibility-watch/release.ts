/** Release compatibility is about reviewed installed bytes, not equality with future main. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { imageInputs } from "../../apps/worker/container/inputs.ts";
import { canonicalJson } from "../../packages/fortipi-contract/src/canonical-json.ts";
import { checkPins } from "../../scripts/check-pins.ts";
import { dependencyPatches } from "../../scripts/dependency-patches.ts";
import { installedReferenceIds, sources } from "./catalog.ts";
import { exitCode, hash, localPins, type Result, type Snapshot } from "./watch.ts";

export const installedReferences = installedReferenceIds;
export type InstalledReference = (typeof installedReferences)[number];
const packages: Record<InstalledReference, string[]> = {
  "pi-runtime": [
    "pi-durable",
    "pi-ai",
    "pi-schema",
    "chord",
    "pi-codemode",
    "pi-telemetry",
    "pi-tui",
  ].map((n) => `@earendil-works/${n}@1.5.2`),
  "agents-lifecycle": ["agents@0.33.0"],
  "computer-fuse": ["@cloudflare/computer@0.11.1"],
  wrangler: [
    "wrangler@4.162.0",
    "miniflare@5.20261113.0-beta",
    "workerd@1.20261113.1",
    "@cloudflare/workers-types@5.20261113.1",
  ],
};
export const releaseHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const bytesHash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const digest = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const v = object(value);
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort(), "Unrecognized compatibility fields");
  return v;
}
function time(value: unknown, now: number, fresh = false): void {
  assert.ok(typeof value === "string" && Number.isFinite(Date.parse(value)));
  const age = now - Date.parse(value);
  assert.ok(age >= -60_000 && (!fresh || age <= 86_400_000), "Stale/future compatibility evidence");
}
export interface PrimaryReference {
  uri: string;
  sha256: string;
}
export interface ReleaseReferenceEntry {
  sourceFactsSha256: string;
  currentImpact: "reviewed" | "hold" | "unknown";
  basisReviewedAt: string;
  primaryReferences: PrimaryReference[];
  limitation: string;
}
export interface ReleaseReference {
  format: 1;
  cohort: Record<string, unknown>;
  cohortSha256: string;
  references: Record<InstalledReference, ReleaseReferenceEntry>;
}
export interface ReleaseBasis {
  sourceCommit: string;
  cohort: Record<string, unknown>;
  cohortSha256: string;
  sourceFacts: Record<InstalledReference, string>;
  primaryReferences: Record<InstalledReference, PrimaryReference[]>;
  validationInputs: { workspaceSha256: string; sourcePolicySha256: string };
  pins: Record<string, Record<string, string>>;
}
export interface CompatibilityReport {
  format: 2;
  sourceCommit: string;
  checkedAt: string;
  catalogSha256: string;
  baselineSha256: string;
  cohortSha256: string;
  validationInputs: ReleaseBasis["validationInputs"];
  lookahead: { format: 1; checkedAt: string; results: Result[]; exitCode: number };
  requiredReferences: {
    current: Result[];
    installed: Record<InstalledReference, ReleaseReferenceEntry>;
  };
}
export interface CompatibilityDetail extends Record<string, unknown> {
  detailSchemaVersion: 2;
  candidateHash: string;
  sourceCommit: string;
  reportSha256: string;
  cohortSha256: string;
  requiredReferencesSha256: string;
}

function packageIdentity(policy: Record<string, unknown>, id: string) {
  const r = object(policy[id]);
  assert.match(String(r.integrity), /^sha512-[A-Za-z0-9+/]{86}==$/);
  for (const k of ["archiveSha256", "manifestSha256"]) assert.match(String(r[k]), digest);
  return {
    id,
    integrity: r.integrity,
    archiveSha256: r.archiveSha256,
    manifestSha256: r.manifestSha256,
  };
}
export function immutablePolicyInputs(workspaceBytes: Uint8Array, policyBytes: Uint8Array) {
  const workspace = object(parse(Buffer.from(workspaceBytes).toString()));
  delete workspace.minimumReleaseAgeExclude;
  const policy = object(object(JSON.parse(Buffer.from(policyBytes).toString())).packages);
  return {
    workspaceInputs: releaseHash(workspace),
    sourcePolicyInputs: releaseHash(
      Object.keys(policy)
        .sort()
        .map((id) => packageIdentity(policy, id)),
    ),
  };
}

/** Current trusted source and existing archive/patch/image facts; no new resolver or authority. */
export async function releaseBasis(
  root: string,
  sourceCommit: string,
  retainedImageMetadata?: Uint8Array,
): Promise<ReleaseBasis> {
  assert.match(sourceCommit, commit);
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)("git", args, { cwd: root, timeout: 15000, maxBuffer: 8_000_000 })
    ).stdout.trim();
  assert.equal(await git("rev-parse", "HEAD"), sourceCommit);
  await git(
    "diff",
    "--exit-code",
    sourceCommit,
    "--",
    "apps/worker",
    "packages",
    "patches",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tools/unstale/supply-chain.json",
    "tools/unstale/pnpm-lock.yaml",
    "tools/unstale/platform-tools.json",
  );
  const read = async (path: string) => {
    const file = resolve(root, path),
      stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8_000_000);
    return readFile(file);
  };
  const json = async (path: string) => object(JSON.parse((await read(path)).toString()));
  const workspaceBytes = await read("pnpm-workspace.yaml");
  const policyBytes = await read("tools/unstale/supply-chain.json");
  const policy = object(object(JSON.parse(policyBytes.toString())).packages);
  const patches = await dependencyPatches(root, true);
  const metadataBytes = retainedImageMetadata
    ? Buffer.from(retainedImageMetadata)
    : await read("apps/worker/dist/container/image-metadata.json");
  assert.ok(metadataBytes.length <= 8_000_000);
  const metadata = object(JSON.parse(metadataBytes.toString()));
  assert.equal(metadata.computerSource, imageInputs.source);
  assert.equal(metadata.computerVersion, imageInputs.computerVersion);
  for (const k of ["sourceKitSha256"]) assert.match(String(metadata[k]), digest);
  assert.match(String(metadata.sourceCommit), commit);
  assert.match(String(metadata.builtManifestDigest), /^sha256:[a-f0-9]{64}$/);
  const cohort = {
    rootManifest: bytesHash(await read("package.json")),
    rootLock: bytesHash(await read("pnpm-lock.yaml")),
    workspaceInputs: immutablePolicyInputs(workspaceBytes, policyBytes).workspaceInputs,
    toolingLock: bytesHash(await read("tools/unstale/pnpm-lock.yaml")),
    sourcePolicyInputs: immutablePolicyInputs(workspaceBytes, policyBytes).sourcePolicyInputs,
    patchReview: bytesHash(await read("patches/review.json")),
    patchTree: await git("rev-parse", `${sourceCommit}:patches`),
    platformTools: bytesHash(await read("tools/unstale/platform-tools.json")),
    imageInputs: bytesHash(await read("apps/worker/container/inputs.ts")),
    productTrees: {
      worker: await git("rev-parse", `${sourceCommit}:apps/worker`),
      packages: await git("rev-parse", `${sourceCommit}:packages`),
    },
    image: {
      sourceCommit: metadata.sourceCommit,
      metadataSha256: bytesHash(metadataBytes),
      builtManifestDigest: metadata.builtManifestDigest,
      sourceKitSha256: metadata.sourceKitSha256,
    },
  };
  const sourceFacts = {} as ReleaseBasis["sourceFacts"],
    primaryReferences = {} as ReleaseBasis["primaryReferences"];
  for (const id of installedReferences) {
    const ids = packages[id].toSorted();
    sourceFacts[id] = releaseHash(ids.map((id) => packageIdentity(policy, id)));
    primaryReferences[id] = [];
    for (const packageId of ids) {
      const r = object(policy[packageId]);
      const name = String(r.name),
        version = String(r.version),
        basename = name.split("/").at(-1);
      assert.equal(`${name}@${version}`, packageId);
      primaryReferences[id].push({
        uri: `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`,
        sha256: String(r.archiveSha256),
      });
      const patch = patches[packageId];
      if (patch) {
        const changedAt = await git("log", "-1", "--format=%H", sourceCommit, "--", patch.path);
        assert.match(changedAt, commit);
        primaryReferences[id].push({
          uri: `https://raw.githubusercontent.com/scottdraper8/fortipi/${changedAt}/${patch.path}`,
          sha256: patch.sha256,
        });
      }
    }
  }
  // Existing source attribution and accepted image are separate from the client TGZ.
  const attribution = object(object(await json("tools/unstale/license-policy.json")).attributions)[
    "@cloudflare/computer@0.11.1"
  ];
  const a = object(attribution);
  assert.equal(a.source, `https://github.com/cloudflare/computer/tree/${imageInputs.source}`);
  primaryReferences["computer-fuse"].push({
    uri: `https://github.com/cloudflare/computer/archive/${imageInputs.source}.tar.gz`,
    sha256: imageInputs.sourceArchiveSha256,
  });
  const pins: ReleaseBasis["pins"] = {};
  for (const source of sources) pins[source.id] = await localPins(source, root);
  return {
    sourceCommit,
    cohort,
    cohortSha256: releaseHash(cohort),
    sourceFacts,
    primaryReferences,
    validationInputs: {
      workspaceSha256: bytesHash(workspaceBytes),
      sourcePolicySha256: bytesHash(policyBytes),
    },
    pins,
  };
}

function snapshot(value: unknown, source: (typeof sources)[number]): asserts value is Snapshot {
  const s = closed(value, ["commit", "version", "sha256", "paths"]);
  assert.match(String(s.commit), commit);
  assert.match(String(s.sha256), digest);
  assert.deepEqual(Object.keys(object(s.paths)).sort(), [...source.paths].sort());
  for (const h of Object.values(object(s.paths))) assert.match(String(h), digest);
  if (source.paths.length)
    assert.equal(
      hash(Object.fromEntries(source.paths.map((path) => [path, object(s.paths)[path]]))),
      s.sha256,
    );
  if (source.manifest || !source.paths.length)
    assert.ok(typeof s.version === "string" && s.version.length > 0);
  else assert.equal(s.version, null);
}
/** Pure comparison for controlled protocol fixtures; callers cannot use it as producer authority. */
export function assessReleaseReport(
  value: unknown,
  basis: ReleaseBasis,
  baselineValue: unknown,
  now = Date.now(),
): asserts value is CompatibilityReport {
  const r = closed(value, [
    "format",
    "sourceCommit",
    "checkedAt",
    "catalogSha256",
    "baselineSha256",
    "cohortSha256",
    "validationInputs",
    "lookahead",
    "requiredReferences",
  ]);
  assert.equal(r.format, 2);
  assert.equal(r.sourceCommit, basis.sourceCommit);
  time(r.checkedAt, now, true);
  assert.equal(r.catalogSha256, releaseHash(sources));
  assert.equal(r.baselineSha256, releaseHash(baselineValue));
  assert.equal(r.cohortSha256, basis.cohortSha256);
  assert.deepEqual(r.validationInputs, basis.validationInputs);
  const b = closed(baselineValue, ["format", "entries", "releaseReference"]);
  assert.equal(b.format, 1);
  const reference = closed(b.releaseReference, ["format", "cohort", "cohortSha256", "references"]);
  assert.equal(reference.format, 1);
  assert.deepEqual(reference.cohort, basis.cohort);
  assert.equal(reference.cohortSha256, releaseHash(reference.cohort));
  assert.equal(reference.cohortSha256, basis.cohortSha256);
  const entries = object(b.entries);
  assert.deepEqual(Object.keys(entries).sort(), sources.map((s) => s.id).sort());
  const refs = closed(reference.references, installedReferences);
  for (const id of installedReferences) {
    const e = closed(refs[id], [
      "sourceFactsSha256",
      "currentImpact",
      "basisReviewedAt",
      "primaryReferences",
      "limitation",
    ]);
    assert.equal(e.sourceFactsSha256, basis.sourceFacts[id]);
    assert.equal(e.currentImpact, "reviewed", "Unresolved current impact");
    time(e.basisReviewedAt, now);
    assert.deepEqual(e.primaryReferences, basis.primaryReferences[id]);
    assert.ok(
      typeof e.limitation === "string" && e.limitation.length > 20 && e.limitation.length <= 2000,
    );
  }
  const watch = closed(r.lookahead, ["format", "checkedAt", "results", "exitCode"]);
  assert.equal(watch.format, 1);
  time(watch.checkedAt, now, true);
  assert.equal(watch.checkedAt, r.checkedAt);
  assert.ok(Array.isArray(watch.results));
  assert.deepEqual(watch.results.map((v) => object(v).id).sort(), sources.map((s) => s.id).sort());
  for (const source of sources) {
    const row = closed(
      watch.results.find((v) => object(v).id === source.id),
      ["id", "outcome", "classification", "baseline", "observed", "pins", "action", "links"],
    );
    const entry = object(entries[source.id]);
    assert.equal(entry.catalogSha256, hash(source));
    time(entry.reviewedAt, now);
    assert.ok(
      typeof entry.reviewNote === "string" &&
        entry.reviewNote.length > 20 &&
        entry.reviewNote.length <= 1000,
    );
    snapshot(entry.snapshot, source);
    if (row.pins !== null) assert.deepEqual(row.pins, basis.pins[source.id]);
    if (row.baseline !== null) assert.deepEqual(row.baseline, entry.snapshot);
    assert.deepEqual(entry.pins, basis.pins[source.id]);
    assert.ok(
      typeof row.action === "string" &&
        Array.isArray(row.links) &&
        row.links.every((v) => typeof v === "string"),
    );
    if (row.observed !== null) {
      snapshot(row.observed, source);
    }
    const required = !installedReferences.includes(source.id as InstalledReference);
    if (row.outcome === "unchanged" || row.outcome === "review-required") {
      assert.ok(row.observed && row.baseline && row.pins);
      const same = object(row.observed).sha256 === object(entry.snapshot).sha256;
      assert.equal(row.outcome, same ? "unchanged" : "review-required");
      assert.equal(row.classification, same ? "reviewed-reference" : "unknown");
    } else {
      assert.ok(row.outcome === "unknown" || row.outcome === "check-unavailable");
      assert.equal(row.classification, "unknown");
    }
    if (required)
      assert.equal(row.outcome, "unchanged", "Required current reference changed/unavailable");
  }
  assert.equal(watch.exitCode, exitCode(watch.results as Result[]));
  const required = closed(r.requiredReferences, ["current", "installed"]);
  assert.deepEqual(
    required.current,
    watch.results.filter((v) => !installedReferences.includes(object(v).id as InstalledReference)),
  );
  assert.deepEqual(required.installed, refs);
}

/** Bytes must first be bound to the actual candidate producer/payload by the caller. */
export interface RetainedCompatibilityInputs {
  imageMetadata: Uint8Array;
  advisoryReview: Uint8Array;
}
export async function validateReleaseReport(
  root: string,
  value: unknown,
  sourceCommit: string,
  now = Date.now(),
  retained?: RetainedCompatibilityInputs,
): Promise<CompatibilityReport> {
  const basis = await releaseBasis(root, sourceCommit, retained?.imageMetadata);
  const baselinePath = "tools/compatibility-watch/baseline.json";
  const rawBaseline = await readFile(resolve(root, baselinePath), "utf8");
  const committed = await promisify(execFile)("git", ["show", `${sourceCommit}:${baselinePath}`], {
    cwd: root,
    timeout: 15000,
    maxBuffer: 1_000_000,
  });
  assert.equal(rawBaseline, committed.stdout, "Release references must be source-committed");
  const baseline = JSON.parse(rawBaseline);
  // Reuse the full current age/expiry/lock/signature/lifecycle/patch/advisory enforcement.
  let advisory: unknown;
  if (retained) {
    closed(retained, ["imageMetadata", "advisoryReview"]);
    assert.ok(
      retained.advisoryReview.byteLength > 0 && retained.advisoryReview.byteLength <= 1_000_000,
    );
    advisory = JSON.parse(Buffer.from(retained.advisoryReview).toString());
    const receipt = closed(advisory, ["format", "reviewSha256", "locks", "advisory"]);
    closed(receipt.locks, ["pnpm-lock.yaml", "tools/unstale/pnpm-lock.yaml"]);
    closed(receipt.advisory, ["checkedAt", "identities", "findings"]);
  }
  await checkPins(root, advisory);
  assessReleaseReport(value, basis, baseline, now);
  return value;
}
export async function createReleaseReport(
  root: string,
  results: Result[],
  checkedAt: string,
): Promise<CompatibilityReport> {
  const sourceCommit = (
    await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 15000 })
  ).stdout.trim();
  const basis = await releaseBasis(root, sourceCommit);
  const baseline = JSON.parse(
    await readFile(resolve(root, "tools/compatibility-watch/baseline.json"), "utf8"),
  );
  const report: CompatibilityReport = {
    format: 2,
    sourceCommit,
    checkedAt,
    catalogSha256: releaseHash(sources),
    baselineSha256: releaseHash(baseline),
    cohortSha256: basis.cohortSha256,
    validationInputs: basis.validationInputs,
    lookahead: { format: 1, checkedAt, results, exitCode: exitCode(results) },
    requiredReferences: {
      current: results.filter((r) => !installedReferences.includes(r.id as InstalledReference)),
      installed: baseline.releaseReference.references,
    },
  };
  return validateReleaseReport(root, report, sourceCommit);
}
export function compatibilityDetail(
  report: CompatibilityReport,
  reportBytes: Uint8Array,
  candidateHash: string,
): CompatibilityDetail {
  assert.match(candidateHash, digest);
  assert.deepEqual(JSON.parse(Buffer.from(reportBytes).toString()), report);
  return {
    detailSchemaVersion: 2,
    candidateHash,
    sourceCommit: report.sourceCommit,
    reportSha256: bytesHash(reportBytes),
    cohortSha256: report.cohortSha256,
    requiredReferencesSha256: releaseHash(report.requiredReferences),
  };
}
export function assertCompatibilityDetail(
  value: unknown,
  report: CompatibilityReport,
  reportBytes: Uint8Array,
  candidateHash: string,
): void {
  assert.deepEqual(
    value,
    compatibilityDetail(report, reportBytes, candidateHash),
    "Compatibility detail/source/report differs or is legacy",
  );
}
