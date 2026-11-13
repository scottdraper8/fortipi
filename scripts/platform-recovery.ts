import assert from "node:assert/strict";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyAssets, verifyPrepared } from "../packages/fortipi-cli/dist/assets.js";
import type { WranglerPort } from "../packages/fortipi-cli/dist/wrangler.js";
import {
  assertTarget,
  type CloudflareRead,
  observeDeployment,
  type TargetDescriptor,
} from "./deploy-smoke.ts";
import { loadCandidate } from "./prepare-release.ts";
import {
  assertDeployment,
  canonicalJson,
  commitPattern,
  type DeploymentIdentity,
  digest,
  type FileRecord,
  freshness,
  object,
  privilegedCheckout,
  readJson,
  regularBytes,
  saveJson,
  sha256,
  string,
} from "./verify-release-gates.ts";

/** Internal trusted coordination only. Application checkpoints/oracles belong to10. */
export interface RecoveryInput {
  candidatePath: string;
  candidateSha256: string;
  sourceCommit: string;
  preparedDirectory: string;
  target: TargetDescriptor;
  before: DeploymentIdentity;
  operationId: string;
  journalDirectory: string;
  /** Trusted prebound child output directory; the child supplies only its FileRecord. */
  checkpointDirectory: string;
  beforeCheckpoint: FileRecord;
}
export type RecoveryRequest = RecoveryInput &
  ({ mode: "perform" } | { mode: "verify-existing"; retainedTransitionSha256: string });
export interface RecoveryPorts {
  /** Fresh per invocation, protected/account-bound; also needs DO namespace inventory. */
  read: CloudflareRead;
  /** The trusted caller supplies its verified installed pinned Wrangler port. */
  wrangler?: WranglerPort;
  applicationTransport: typeof fetch;
  applicationAdminToken: string;
}
interface VersionSnapshot {
  etagSha256: string;
  bindingsSha256: string;
  runtimeSha256: string;
  namespaces: { className: string; namespaceId: string }[];
  secretNames: string[];
}
interface Intent {
  schemaVersion: 1;
  operationId: string;
  candidateSha256: string;
  sourceCommit: string;
  assetManifestSha256: string;
  preparedConfigSha256: string;
  modulesSha256: string;
  targetSha256: string;
  before: DeploymentIdentity;
  beforeCheckpointSha256: string;
  version: VersionSnapshot;
  annotation: string;
  requestedStrategy: "immediate";
  strategyReadBack: false;
}
/** Provider confirmation is deliberately NOT an application recovery result/GateReceipt. */
export interface ProviderTransition {
  schemaVersion: 1;
  phase: "provider-confirmed";
  operationId: string;
  intentSha256: string;
  candidateSha256: string;
  beforeCheckpointSha256: string;
  before: DeploymentIdentity;
  after: DeploymentIdentity;
  requestedStrategy: "immediate";
  strategyReadBack: false;
  reset: "inferred-from-provider-contract";
  incarnation: "not-observed";
  eviction: "not-observed";
  physicalHostLoss: "not-observed";
  requiresApplicationVerification: true;
}
export interface ProviderPhaseResult {
  transition: ProviderTransition;
  transitionSha256: string;
  /** Fresh independent read, separate from the immutable historical transition. */
  current: DeploymentIdentity;
}
const uuid = (value: unknown): string => {
  const result = string(value);
  assert.match(result, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  return result;
};
const equal = (a: unknown, b: unknown) => assert.equal(canonicalJson(a), canonicalJson(b));
const hash = (value: unknown) => sha256(canonicalJson(value));
const withoutTime = ({ checkedAt: _time, ...identity }: DeploymentIdentity) => identity;

async function optional(path: string): Promise<unknown | undefined> {
  try {
    return await readJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** Exclusive immutable markers, fsynced by existing9's artifact writer before effects. */
async function first(path: string, value: unknown): Promise<boolean> {
  try {
    await saveJson(path, value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    equal(await readJson(path), value);
    return false;
  }
}

async function coordinate(
  input: RecoveryRequest,
  ports: RecoveryPorts,
): Promise<ProviderPhaseResult> {
  assert.ok(input.mode === "perform" || input.mode === "verify-existing");
  assert.match(input.operationId, /^[a-f0-9]{32}$/);
  assert.match(input.sourceCommit, commitPattern);
  digest(input.candidateSha256);
  assertTarget(input.target);
  assertDeployment(input.before);
  const { candidate, hash: candidateHash } = await loadCandidate(input.candidatePath);
  assert.equal(candidateHash, input.candidateSha256);
  assert.equal(
    candidate.publishable,
    true,
    "Synthetic candidates cannot authorize provider writes",
  );
  assert.equal(candidate.sourceCommit, input.sourceCommit);
  await privilegedCheckout(candidate);
  const journal = resolve(input.journalDirectory);
  const prepared = resolve(input.preparedDirectory);
  assert.ok(journal !== prepared && !journal.startsWith(`${prepared}/`));
  if (input.mode === "perform") await mkdir(journal, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(journal), journal);
  const file = (name: string) => resolve(journal, name);
  const script = `/workers/scripts/${input.before.workerName}`;
  const annotation = `fortipi-recovery-${input.operationId}`;
  const config = await verifyPrepared(prepared);
  assert.equal(config.sourceCommit, input.sourceCommit);
  assert.equal(config.assetManifestSha256, candidate.assetManifestSha256);
  equal(config.operator, input.target.operator);
  const assets = await verifyAssets(resolve(prepared, "assets"));
  const modulesSha256 = hash(assets.manifest.files.filter((f) => f.kind === "worker"));
  const configSha256 = sha256(await regularBytes(resolve(prepared, "wrangler.json")));
  const checkpoint = async () => {
    const record = input.beforeCheckpoint;
    assert.equal(record.path, resolve(input.checkpointDirectory, "application-before.json"));
    assert.equal(record.mode, 0o600);
    assert.equal((await lstat(record.path)).mode & 0o777, record.mode);
    assert.ok(record.size > 0 && record.size <= 1048576);
    const bytes = await regularBytes(record.path);
    assert.equal(bytes.length, record.size);
    assert.equal(sha256(bytes), digest(record.sha256));
    const value = object(JSON.parse(bytes.toString("utf8")));
    assert.equal(bytes.toString("utf8"), `${canonicalJson(value)}\n`);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.candidateSha256, candidateHash);
    assert.equal(value.sourceCommit, input.sourceCommit);
    assert.equal(value.workerVersionId, input.before.workerVersionId);
    assert.equal(value.deploymentId, input.before.deploymentId);
    return value;
  };
  await checkpoint();
  const recheck = async () => {
    await checkpoint();
    await privilegedCheckout(candidate);
    equal(await verifyPrepared(prepared), config);
    assert.equal(sha256(await regularBytes(resolve(prepared, "wrangler.json"))), configSha256);
    assert.equal((await loadCandidate(input.candidatePath)).hash, candidateHash);
  };
  const observation = async (versionId: string) =>
    observeDeployment(
      candidate,
      candidateHash,
      input.target,
      prepared,
      {
        workerName: config.operator.deployment.name,
        origin: config.operator.deployment.origin,
        targets: [config.operator.deployment.origin],
        workerVersionId: versionId,
        sourceCommit: config.sourceCommit,
        packageVersion: config.packageVersion,
        assetManifestSha256: config.assetManifestSha256,
        configSha256: config.configSha256,
      },
      ports.read,
      ports.applicationTransport,
      ports.applicationAdminToken,
    );
  const version = async (id: string) => {
    const value = object(await ports.read(`${script}/versions/${uuid(id)}`));
    assert.equal(value.id, id);
    return value;
  };
  const versions = async (): Promise<string[]> => {
    const rows = object(await ports.read(`${script}/versions?per_page=100`)).items;
    assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 100);
    const ids = rows.map((row) => uuid(object(row).id));
    assert.equal(new Set(ids).size, ids.length);
    return ids;
  };
  const snapshot = async (id: string): Promise<VersionSnapshot> => {
    const v = await version(id);
    const resources = object(v.resources);
    const bindings = resources.bindings;
    assert.ok(Array.isArray(bindings) && bindings.length <= 128);
    const names = bindings.map((b) => string(object(b).name));
    assert.equal(new Set(names).size, names.length);
    const secretNames: string[] = [];
    const safeBindings = bindings
      .map((raw) => {
        const b = object(raw);
        if (b.type === "secret_text") {
          assert.match(string(b.name), /^[A-Z][A-Z0-9_]{0,127}$/);
          secretNames.push(string(b.name));
          return { name: b.name, type: b.type };
        }
        return b;
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "en"));
    assert.ok(secretNames.includes("FORTIPI_ADMIN_TOKEN"));
    const runtime = object(resources.script_runtime);
    const exports = object(runtime.exports);
    const declared = object(await readJson(resolve(prepared, "wrangler.json")));
    const required = object(declared.durable_objects).bindings;
    assert.ok(Array.isArray(required) && required.length <= 16);
    const inventory = await ports.read("/workers/durable_objects/namespaces?page=1&per_page=1000");
    // A full page cannot establish a complete inventory: fail instead of silently truncating.
    assert.ok(Array.isArray(inventory) && inventory.length < 1000);
    const namespaces = required
      .map((raw) => {
        const binding = object(raw);
        const className = string(binding.class_name);
        const definition = object(exports[className]);
        assert.equal(definition.type, "durable-object");
        assert.equal(definition.storage, "sqlite");
        assert.equal(definition.state ?? "created", "created");
        // GetVersion permits omitted state; omission means created, not a migration.
        definition.state = "created";
        const matches = inventory
          .map(object)
          .filter((row) => row.script === input.before.workerName && row.class === className);
        assert.equal(matches.length, 1, "Namespace identity unavailable/ambiguous");
        assert.equal(matches[0]?.use_sqlite, true);
        return { className, namespaceId: string(matches[0]?.id, 128) };
      })
      .sort((a, b) => a.className.localeCompare(b.className, "en"));
    return {
      etagSha256: sha256(string(object(resources.script).etag)),
      bindingsSha256: hash(safeBindings),
      runtimeSha256: hash(runtime),
      namespaces,
      secretNames: secretNames.sort(),
    };
  };
  const old = await optional(file("intent.json"));
  let intent: Intent;
  if (old === undefined) {
    assert.equal(input.mode, "perform");
    freshness(input.before.checkedAt, 0.25);
    freshness(string((await checkpoint()).capturedAt), 0.25);
    equal(withoutTime(await observation(input.before.workerVersionId)), withoutTime(input.before));
    assert.equal((await versions())[0], input.before.workerVersionId, "Unrelated latest upload");
    intent = {
      schemaVersion: 1,
      operationId: input.operationId,
      candidateSha256: candidateHash,
      sourceCommit: input.sourceCommit,
      assetManifestSha256: candidate.assetManifestSha256,
      preparedConfigSha256: configSha256,
      modulesSha256,
      targetSha256: hash(input.target),
      before: input.before,
      beforeCheckpointSha256: input.beforeCheckpoint.sha256,
      version: await snapshot(input.before.workerVersionId),
      annotation,
      requestedStrategy: "immediate",
      strategyReadBack: false,
    };
    await recheck();
    await first(file("intent.json"), intent);
  } else {
    const expected: Intent = {
      schemaVersion: 1,
      operationId: input.operationId,
      candidateSha256: candidateHash,
      sourceCommit: input.sourceCommit,
      assetManifestSha256: candidate.assetManifestSha256,
      preparedConfigSha256: configSha256,
      modulesSha256,
      targetSha256: hash(input.target),
      before: input.before,
      beforeCheckpointSha256: input.beforeCheckpoint.sha256,
      version: await snapshot(input.before.workerVersionId),
      annotation,
      requestedStrategy: "immediate",
      strategyReadBack: false,
    };
    equal(old, expected);
    intent = expected;
  }
  const intentSha256 = sha256(await regularBytes(file("intent.json")));
  const guardLatest = async (next?: string) => {
    const ids = await versions();
    if (next === undefined)
      assert.equal(ids[0], input.before.workerVersionId, "Unrelated latest upload");
    else equal(ids.slice(0, 2), [next, input.before.workerVersionId]);
  };
  const readTransition = async () => {
    try {
      const bytes = await regularBytes(file("transition.json"));
      return { value: JSON.parse(bytes.toString("utf8")) as unknown, sha256: sha256(bytes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const retained = input.mode === "verify-existing" ? await readTransition() : undefined;
  if (input.mode === "verify-existing") {
    digest(input.retainedTransitionSha256);
    assert.ok(retained);
    assert.equal(retained.sha256, input.retainedTransitionSha256);
  }
  const attempted = { intentSha256 };
  if (input.mode === "perform" && (await first(file("upload-attempt.json"), attempted))) {
    await guardLatest();
    await recheck();
    assert.ok(ports.wrangler);
    try {
      await ports.wrangler.run({
        args: [
          "versions",
          "upload",
          "--config",
          resolve(prepared, "wrangler.json"),
          "--tag",
          annotation,
        ],
        cwd: prepared,
        deploymentAuth: true,
      });
    } catch {
      /* An attempted upload is reconciled, never repeated on uncertainty. */
    }
  }
  equal(await readJson(file("upload-attempt.json")), attempted);
  const latest = (await versions())[0];
  assert.ok(latest && latest !== input.before.workerVersionId, "Upload unconfirmed; do not retry");
  const uploaded = await version(latest);
  assert.equal(object(uploaded.annotations)["workers/tag"], annotation);
  await guardLatest(latest);
  equal(await snapshot(latest), intent.version);
  await recheck();
  const deploymentAttempt = { intentSha256, versionId: latest, requestedStrategy: "immediate" };
  if (
    input.mode === "perform" &&
    (await first(file("deployment-attempt.json"), deploymentAttempt))
  ) {
    await guardLatest(latest);
    await recheck();
    assert.ok(ports.wrangler);
    try {
      await ports.wrangler.run({
        args: [
          "versions",
          "deploy",
          `${latest}@100%`,
          "--config",
          resolve(prepared, "wrangler.json"),
          "--durable-objects-code-update-mode",
          "immediate",
          "--yes",
        ],
        cwd: prepared,
        deploymentAuth: true,
      });
    } catch {
      /* Only independent provider observation can confirm an attempted deploy. */
    }
  }
  equal(await readJson(file("deployment-attempt.json")), deploymentAttempt);
  const after = await observation(latest);
  assert.notEqual(after.deploymentId, input.before.deploymentId);
  equal(withoutTime(after), {
    ...withoutTime(input.before),
    workerVersionId: latest,
    deploymentId: after.deploymentId,
    versions: [{ versionId: latest, percentage: 100 }],
  });
  await guardLatest(latest);
  equal(await snapshot(latest), intent.version);
  await recheck();
  const result: ProviderTransition = {
    schemaVersion: 1,
    phase: "provider-confirmed",
    operationId: input.operationId,
    intentSha256,
    candidateSha256: candidateHash,
    beforeCheckpointSha256: input.beforeCheckpoint.sha256,
    before: input.before,
    after,
    requestedStrategy: "immediate",
    strategyReadBack: false,
    reset: "inferred-from-provider-contract",
    incarnation: "not-observed",
    eviction: "not-observed",
    physicalHostLoss: "not-observed",
    requiresApplicationVerification: true,
  };
  const saved = retained ?? (await readTransition());
  if (saved !== undefined) {
    const previous = object(saved.value);
    equal({ ...previous, after }, result);
    assertDeployment(previous.after);
    equal(withoutTime(previous.after), withoutTime(after));
    return {
      transition: saved.value as ProviderTransition,
      transitionSha256: saved.sha256,
      current: after,
    };
  }
  assert.equal(input.mode, "perform");
  await first(file("transition.json"), result);
  const written = await readTransition();
  assert.ok(written);
  equal(written.value, result);
  return {
    transition: written.value as ProviderTransition,
    transitionSha256: written.sha256,
    current: after,
  };
}

export async function recoverProvider(
  input: RecoveryRequest,
  ports: RecoveryPorts,
): Promise<ProviderPhaseResult> {
  try {
    return await coordinate(input, ports);
  } catch {
    // Neither provider/runner responses nor operator/credential values enter diagnostics.
    throw new Error("Platform recovery unavailable or inconsistent; no recovery claim qualified");
  }
}
