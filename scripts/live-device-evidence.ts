import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPrepared } from "../packages/fortipi-cli/dist/assets.js";
import {
  assertDeviceEvidenceData,
  type DeviceEvidenceData,
  observeDeviceContinuation,
} from "../tests/clients/device-observer.ts";
import {
  type DeviceContinuityA,
  type DeviceContinuityBObservation,
  type DeviceContinuitySeed,
  type DeviceJobRead,
  runDeviceContinuityA,
  runDeviceContinuityB,
} from "../tests/clients/live-device.ts";
import { type IssuedRole, RoleContext } from "../tests/clients/roles.ts";
import { validateRecoveryRetention } from "./application-recovery-retention.ts";
import { cloudflareRequest, observeDeployment } from "./deploy-smoke.ts";
import {
  authorizeCurrentDeviceJob,
  type CurrentDeviceJobContext,
  currentDeviceJobContext,
  type DeviceJob,
  type DevicePhase,
  type DevicePhaseArtifact,
  type DevicePhaseMetadata,
  deviceTargetIdentitySha256,
  type LoadedDeviceCandidate,
  readDeviceCustodyArtifact,
  readDeviceOwnershipArtifact,
  readDevicePhaseArtifact,
} from "./device-phase-artifacts.ts";
import {
  allocateLiveDeviceReadRole,
  allocateLiveDeviceRoles,
  assertLiveDeviceOwnership,
  cleanupLiveDeviceRoles,
  type LiveDeviceCleanup,
  type LiveDeviceOwnership,
} from "./live-device-allocation.ts";
import {
  type LiveDeviceCustodyFrame,
  openLiveDeviceRole,
  sealLiveDeviceRole,
} from "./live-device-custody.ts";
import {
  installLiveDeviceCandidate,
  loadLiveDeviceInstallation,
} from "./live-device-installation.ts";
import {
  type ArtifactReference,
  assertDeployment,
  assertGate,
  canonicalJson,
  cliArgs,
  type DeploymentIdentity,
  freshness,
  githubRequest,
  integer,
  inventory,
  object,
  REPOSITORY,
  readJson,
  readProofBundle,
  regularBytes,
  saveJson,
  sha256,
  string,
  verifyPayload,
  verifyProducer,
} from "./verify-release-gates.ts";

const stable = ({ checkedAt: _time, ...identity }: DeploymentIdentity) => identity;
const maximum = 1_048_576;
type Setup = Awaited<ReturnType<typeof setup>>;
async function setup(installationPath: string, expected: DeviceJob) {
  const local = await loadLiveDeviceInstallation(installationPath);
  const loaded: LoadedDeviceCandidate = {
    candidate: local.installed.candidate,
    hash: local.installed.hash,
  };
  const context = currentDeviceJobContext();
  assert.equal(context.job, expected);
  const job = await authorizeCurrentDeviceJob(
    { loaded, context },
    githubRequest(process.env.GITHUB_TOKEN),
  );
  const prepared = await verifyPrepared(local.installed.prepared);
  assert.equal(prepared.sourceCommit, loaded.candidate.sourceCommit);
  assert.equal(prepared.assetManifestSha256, loaded.candidate.assetManifestSha256);
  assert.deepEqual(prepared.operator, local.target.operator);
  return {
    ...local,
    loaded,
    context,
    job,
    mode: context.operation === "deploy" ? ("perform" as const) : ("verify-existing" as const),
  };
}
async function keys(state: Setup, provider = true) {
  // Refresh the actual current source/job/attempt after all artifact awaits.
  await authorizeCurrentDeviceJob(state, githubRequest(process.env.GITHUB_TOKEN));
  const admin = process.env.FORTIPI_ADMIN_TOKEN;
  assert.ok(typeof admin === "string" && admin.length >= 32);
  if (!provider) return { admin, account: undefined, token: undefined };
  const account = process.env.CLOUDFLARE_ACCOUNT_ID,
    token = process.env.CLOUDFLARE_API_TOKEN;
  assert.ok(
    account &&
      /^[a-f0-9]{32}$/.test(account) &&
      sha256(account) === state.target.accountBindingSha256,
  );
  assert.ok(token && token.length > 0);
  return { admin, account, token };
}
async function observe(state: Setup, cli: unknown, secret: Awaited<ReturnType<typeof keys>>) {
  assert.ok(secret.account && secret.token);
  return observeDeployment(
    state.loaded.candidate,
    state.loaded.hash,
    state.target,
    state.installed.prepared,
    cli,
    cloudflareRequest(secret.account, state.target.accountBindingSha256, secret.token),
    fetch,
    secret.admin,
  );
}
function name(
  prefix: string,
  loaded: LoadedDeviceCandidate,
  context: Pick<CurrentDeviceJobContext, "runId" | "runAttempt">,
) {
  return `${prefix}-${loaded.candidate.sourceCommit}-${loaded.candidate.scope}-${context.runId}-${context.runAttempt}`;
}
async function findReference(
  prefix: string,
  loaded: LoadedDeviceCandidate,
  context: CurrentDeviceJobContext,
  expectedId?: number,
): Promise<ArtifactReference> {
  const request = githubRequest(process.env.GITHUB_TOKEN);
  const selected: Record<string, unknown>[] = [];
  for (let page = 1; page <= 20; page++) {
    const listing = object(
      await request(
        `/repos/${REPOSITORY}/actions/runs/${context.runId}/artifacts?per_page=100&page=${page}`,
      ),
    );
    assert.ok(Array.isArray(listing.artifacts) && listing.artifacts.length <= 100);
    const total = integer(listing.total_count);
    assert.ok(total <= 2000);
    selected.push(
      ...listing.artifacts.map(object).filter((row) => row.name === name(prefix, loaded, context)),
    );
    if (page * 100 >= total) break;
    assert.ok(page < 20);
  }
  assert.equal(selected.length, 1, "One exact phase artifact required");
  const artifact = selected[0];
  assert.ok(artifact);
  const artifactId = integer(artifact.id);
  if (expectedId !== undefined) assert.equal(artifactId, expectedId);
  assert.equal(artifact.expired, false);
  const artifactDigest = string(artifact.digest);
  assert.match(artifactDigest, /^sha256:[a-f0-9]{64}$/);
  return {
    runId: context.runId,
    runAttempt: context.runAttempt,
    artifactId,
    artifactName: name(prefix, loaded, context),
    artifactDigest,
    candidateSha256: loaded.hash,
  };
}
function payload(phase: DevicePhaseArtifact, path: string) {
  const result = phase.payloads[path];
  assert.ok(result);
  return result.data;
}
async function initial(loaded: LoadedDeviceCandidate, context: CurrentDeviceJobContext) {
  const reference = await findReference("deployment-initial", loaded, context);
  // Bootstrap an expected identity as DATA, then authenticate the entire phase.
  // It authorizes no provider/role operation; fresh provider observation follows.
  const bytes = await githubRequest(process.env.GITHUB_TOKEN).verifyArtifact(
    reference,
    "deployment.json",
  );
  assert.ok(bytes && bytes.length <= maximum);
  const deployment: unknown = JSON.parse(bytes.toString("utf8"));
  assertDeployment(deployment);
  const input = {
    loaded,
    phase: "initial" as const,
    mode: context.operation === "deploy" ? ("perform" as const) : ("verify-existing" as const),
    reference,
    context: { mode: "current" as const, current: context },
    deployment,
    expectedLinks: {},
  };
  const artifact = await readDevicePhaseArtifact(input, githubRequest(process.env.GITHUB_TOKEN));
  const ownership = payload(artifact, "ownership.json");
  assertLiveDeviceOwnership(ownership);
  assert.equal(ownership.state, "ready");
  assert.equal(ownership.sourceCommit, loaded.candidate.sourceCommit);
  assert.equal(ownership.candidateSha256, loaded.hash);
  assert.deepEqual(stable(ownership.deployment), stable(deployment));
  const seeded = object(payload(artifact, "seed.json"));
  assert.equal(seeded.schemaVersion, 1);
  const seed = object(seeded.seed) as unknown as DeviceContinuitySeed;
  return {
    artifact,
    input,
    ownership,
    seed,
    history: seeded.history as DeviceEvidenceData | undefined,
    cli: payload(artifact, "deployment.cli.json"),
    deployment,
  };
}
async function writeMetadata(
  state: Setup,
  phase: DevicePhase,
  directory: string,
  deployment: DeploymentIdentity,
  links: Pick<
    DevicePhaseMetadata,
    "initialReference" | "aReference" | "bReference" | "custody"
  > = {},
) {
  const files = await inventory(directory);
  assert.ok(files.every((file) => file.mode === 0o600 && file.size > 0 && file.size <= maximum));
  const metadata: DevicePhaseMetadata = {
    schemaVersion: 1,
    phase,
    mode: state.mode,
    sourceCommit: state.loaded.candidate.sourceCommit,
    candidateSha256: state.loaded.hash,
    scope: state.loaded.candidate.scope,
    producer: state.job.producer,
    jobId: state.job.job.id,
    deployment,
    checkedAt: new Date().toISOString(),
    files,
    ...links,
  };
  await saveJson(
    resolve(directory, phase === "initial" ? "device-initial.json" : "device-phase.json"),
    metadata,
  );
}
function frame(
  state: Setup,
  deployment: DeploymentIdentity,
  ownership: LiveDeviceOwnership,
  destination: "client" | "a" | "b",
): LiveDeviceCustodyFrame {
  const owned = ownership.roles.filter((role) => role.name === destination);
  assert.equal(owned.length, 1);
  const role = owned[0];
  assert.ok(role?.credential);
  assert.equal(role.issuance, "known");
  return {
    sourceCommit: state.loaded.candidate.sourceCommit,
    candidateSha256: state.loaded.hash,
    repositoryId: state.loaded.candidate.repositoryId,
    runId: state.context.runId,
    runAttempt: state.context.runAttempt,
    targetIdentitySha256: sha256(
      canonicalJson({
        purpose: "fortipi-device-role-v1",
        target: deviceTargetIdentitySha256(deployment),
        destination,
      }),
    ),
    credentialRef: role.credential,
    createdAt: ownership.createdAt,
    expiresAt: role.expiresAt,
  };
}
async function originalHistory(
  state: Setup,
  proofsPath: string,
  current: DeploymentIdentity,
): Promise<DeviceEvidenceData> {
  const bundle = await readProofBundle(proofsPath);
  const matches = bundle.proofs.filter((proof) => proof.receipt.kind === "live");
  assert.equal(matches.length, 1);
  const proof = matches[0];
  assert.ok(proof);
  assert.equal(proof.artifact.candidateSha256, state.loaded.hash);
  await verifyProducer(
    state.loaded.candidate,
    "live",
    proof.receipt.producer,
    proof.artifact,
    githubRequest(process.env.GITHUB_TOKEN),
  );
  await verifyPayload(proof.directory, proof.receipt.files, ["gate.json"]);
  assert.ok(proof.receipt.claims.every((claim) => claim.outcome === "pass"));
  assert.deepEqual(proof.receipt.deployments.map(stable), [stable(current)]);
  const path = "device-phases/device-evidence.json";
  const record = proof.receipt.files.find((file) => file.path === path);
  assert.ok(record);
  const bytes = await regularBytes(resolve(proof.directory, path), maximum);
  assert.equal(bytes.length, record.size);
  assert.equal(sha256(bytes), record.sha256);
  const devices: DeviceEvidenceData = JSON.parse(bytes.toString("utf8"));
  assertDeviceEvidenceData(devices, current);
  const child = await readJson(resolve(proof.directory, "claims/gate.json"));
  assertGate(child);
  await validateRecoveryRetention({
    candidate: state.loaded.candidate,
    candidateSha256: state.loaded.hash,
    kind: "live",
    child,
    claimsDirectory: resolve(proof.directory, "claims"),
    deployment: current,
    originalCliPath: resolve(proof.directory, "deployment.cli.json"),
    currentReceiptPath: resolve(proof.directory, "deployment.provider-version.json"),
    factsPath: resolve(proof.directory, "recovery-link.json"),
    proofsPath,
    request: githubRequest(process.env.GITHUB_TOKEN),
  });
  await authenticateHistoricalDevices(state.loaded, current, devices);
  return devices;
}
async function authenticateHistoricalDevices(
  loaded: LoadedDeviceCandidate,
  current: DeploymentIdentity,
  devices: DeviceEvidenceData,
) {
  assertDeviceEvidenceData(devices, current);
  const links: { initial?: ArtifactReference; a?: ArtifactReference; b?: ArtifactReference } = {};
  const artifacts: DevicePhaseArtifact[] = [];
  for (const phase of ["initial", "a", "b", "cleanup"] as const) {
    const artifact = await readDevicePhaseArtifact(
      {
        loaded,
        phase,
        mode: "perform",
        reference: devices.references[phase],
        context: { mode: "historical" },
        deployment: devices.initial.deployment,
        expectedLinks: { ...links },
      },
      githubRequest(process.env.GITHUB_TOKEN),
    );
    artifacts.push(artifact);
    if (phase !== "cleanup") links[phase] = artifact.reference;
  }
  const [initialPhase, a, b, cleanup] = artifacts;
  assert.ok(initialPhase && a && b && cleanup);
  assert.deepEqual(object(payload(initialPhase, "seed.json")).seed, devices.initial.seed);
  assert.deepEqual(payload(a, "device-a.json"), devices.a);
  assert.deepEqual(object(payload(b, "device-b.json")).observation, devices.b);
  assert.deepEqual(completeCleanup(payload(cleanup, "device-cleanup.json")), devices.cleanup);
  return artifacts;
}
function completeCleanup(value: unknown): DeviceEvidenceData["cleanup"] {
  const cleanup = object(value) as unknown as LiveDeviceCleanup;
  assert.equal(cleanup.state, "complete");
  assert.ok(Array.isArray(cleanup.roles));
  assert.ok(
    cleanup.roles.every((role) => role.state === "complete" || role.state === "not-issued"),
  );
  return cleanup.roles
    .filter((role) => role.credential !== undefined)
    .map((role) => {
      assert.ok(role.credential && role.receipt && role.state === "complete");
      assert.equal(role.receipt.state, "complete");
      assert.deepEqual(role.receipt.pendingRecipients, []);
      return { credential: role.credential, requestId: role.requestId, receipt: role.receipt };
    });
}

export async function initializeLiveDevices(input: {
  installationPath: string;
  deploymentPath: string;
  proofsPath: string;
  out: string;
}) {
  const state = await setup(input.installationPath, "initial");
  await mkdir(resolve(input.out), { mode: 0o700 });
  const deployment = await readJson(input.deploymentPath);
  assertDeployment(deployment);
  const cli = await readJson(`${input.deploymentPath}.cli.json`);
  assert.equal(deployment.candidateSha256, state.loaded.hash);
  assert.equal(deployment.sourceCommit, state.loaded.candidate.sourceCommit);
  assert.equal(deployment.accountBindingSha256, state.target.accountBindingSha256);
  freshness(deployment.checkedAt, 0.25);
  const history =
    state.mode === "verify-existing"
      ? await originalHistory(state, input.proofsPath, deployment)
      : undefined;
  const secret = await keys(state);
  const current = await observe(state, cli, secret);
  assert.deepEqual(stable(current), stable(deployment));
  const roles = new RoleContext(current.origin, secret.admin);
  const ownershipDirectory = resolve(input.out, "ownership");
  await mkdir(ownershipDirectory, { mode: 0o700 });
  let allocationId: string | undefined;
  const writeJournal = async (body: LiveDeviceOwnership) => {
    roles.assertSanitized(body);
    const first = allocationId === undefined;
    if (!first)
      assert.equal(body.allocationId, allocationId, "Cannot replace an uncertain allocation");
    await saveJson(
      resolve(ownershipDirectory, "ownership.json"),
      {
        schemaVersion: 1,
        sourceCommit: state.loaded.candidate.sourceCommit,
        candidateSha256: state.loaded.hash,
        scope: state.loaded.candidate.scope,
        producer: state.job.producer,
        jobId: state.job.job.id,
        checkedAt: new Date().toISOString(),
        body,
      },
      first,
    );
    allocationId = body.allocationId;
  };
  const allocated = history
    ? await allocateLiveDeviceReadRole({
        roles,
        deployment: current,
        devices: history,
        writeJournal,
      })
    : await allocateLiveDeviceRoles({
        installed: state.installed,
        deployment: current,
        roles,
        bootstrapRoles: new RoleContext(current.origin, secret.admin),
        writeJournal,
      });
  const ownership = allocated.ownership;
  const seed = history
    ? history.initial.seed
    : (allocated as Awaited<ReturnType<typeof allocateLiveDeviceRoles>>).seed;
  assert.equal(ownership.kind, history ? "read" : "perform");
  const carried: Record<string, IssuedRole> = { client: allocated.clientRole };
  if (!history) {
    const performed = allocated as Awaited<ReturnType<typeof allocateLiveDeviceRoles>>;
    carried.a = performed.aRole;
    carried.b = performed.bRole;
  }
  const envelopes = Object.fromEntries(
    Object.entries(carried).map(([destination, role]) => [
      destination,
      sealLiveDeviceRole({
        key: secret.admin,
        role,
        frame: frame(state, current, ownership, destination as "client" | "a" | "b"),
        now: Date.now(),
      }),
    ]),
  );
  const publicDirectory = resolve(input.out, "initial"),
    custodyDirectory = resolve(input.out, "custody");
  await mkdir(publicDirectory, { mode: 0o700 });
  await mkdir(custodyDirectory, { mode: 0o700 });
  const custody = { schemaVersion: 1, roles: envelopes };
  roles.assertSanitized(
    custody,
    Object.values(carried).map((role) => role.token),
  );
  const serialized = Buffer.from(`${canonicalJson(custody)}\n`);
  assert.ok(serialized.length <= 65536);
  await writeFile(resolve(custodyDirectory, "custody.json"), serialized, {
    flag: "wx",
    mode: 0o600,
  });
  await saveJson(resolve(publicDirectory, "deployment.json"), current);
  await saveJson(resolve(publicDirectory, "deployment.cli.json"), cli);
  await saveJson(resolve(publicDirectory, "seed.json"), {
    schemaVersion: 1,
    seed,
    ...(history ? { history } : {}),
  });
  await saveJson(resolve(publicDirectory, "ownership.json"), ownership);
  await state.installed.verifyUnchanged();
}

export async function finalizeInitialDevices(input: {
  installationPath: string;
  out: string;
  custodyId: number;
}) {
  const state = await setup(input.installationPath, "initial");
  const directory = resolve(input.out, "initial");
  const deployment = await readJson(resolve(directory, "deployment.json"));
  assertDeployment(deployment);
  const reference = await findReference(
    "device-custody",
    state.loaded,
    state.context,
    input.custodyId,
  );
  const bytes = await regularBytes(resolve(input.out, "custody/custody.json"), 65536);
  // Upload output alone is insufficient: authenticate the API digest and real ZIP.
  const selected = await githubRequest(process.env.GITHUB_TOKEN).verifyArtifactMembers(reference, {
    "custody.json": 65536,
  });
  assert.deepEqual(selected.members["custody.json"], bytes);
  await writeMetadata(state, "initial", directory, deployment, {
    custody: {
      reference,
      record: { path: "custody.json", mode: 0o600, size: bytes.length, sha256: sha256(bytes) },
    },
  });
}

function restrictedJobs(state: Setup): DeviceJobRead {
  const request = githubRequest(process.env.GITHUB_TOKEN);
  return Object.freeze({
    candidateSha256: state.loaded.hash,
    runId: state.context.runId,
    runAttempt: state.context.runAttempt,
    readJobs: async (page: number) => {
      assert.ok(Number.isSafeInteger(page) && page >= 1 && page <= 20);
      const listing = object(
        await request(
          `/repos/${REPOSITORY}/actions/runs/${state.context.runId}/attempts/${state.context.runAttempt}/jobs?per_page=100&page=${page}`,
        ),
      );
      assert.ok(Array.isArray(listing.jobs) && listing.jobs.length <= 100);
      const total_count = integer(listing.total_count);
      assert.ok(total_count <= 2000);
      return {
        total_count,
        jobs: listing.jobs.map(object).map((row) => ({
          id: integer(row.id),
          name: string(row.name),
          run_id: integer(row.run_id),
          head_sha: string(row.head_sha),
          status: string(row.status),
          conclusion: row.conclusion === null ? null : string(row.conclusion),
          runner_name: row.runner_name === null ? null : string(row.runner_name),
          runner_id: Number(row.runner_id),
          labels: Array.isArray(row.labels) ? row.labels.map((value) => string(value)) : [],
        })),
      };
    },
  });
}

export async function runLiveDevicePhase(input: {
  installationPath: string;
  phase: "a" | "b";
  out: string;
}) {
  const state = await setup(input.installationPath, input.phase);
  const started = await initial(state.loaded, state.context);
  assert.equal(started.ownership.kind, state.mode === "perform" ? "perform" : "read");
  const aReference =
    input.phase === "b" ? await findReference("device-a", state.loaded, state.context) : undefined;
  const previous = aReference
    ? await readDevicePhaseArtifact(
        {
          ...started.input,
          phase: "a",
          reference: aReference,
          expectedLinks: { initial: started.artifact.reference },
        },
        githubRequest(process.env.GITHUB_TOKEN),
      )
    : undefined;
  const custody = await readDeviceCustodyArtifact(
    started.input,
    githubRequest(process.env.GITHUB_TOKEN),
  );
  const document = object(JSON.parse(Buffer.from(custody.base64, "base64").toString("utf8")));
  assert.deepEqual(Object.keys(document).sort(), ["roles", "schemaVersion"]);
  assert.equal(document.schemaVersion, 1);
  const envelopes = object(document.roles);
  assert.deepEqual(
    Object.keys(envelopes).sort(),
    state.mode === "perform" ? ["a", "b", "client"] : ["client"],
  );
  const secret = await keys(state);
  const current = await observe(state, started.cli, secret);
  assert.deepEqual(stable(current), stable(started.deployment));
  const roles = new RoleContext(current.origin, secret.admin);
  const clientRole = openLiveDeviceRole({
    key: secret.admin,
    envelope: envelopes.client,
    expectedFrame: frame(state, current, started.ownership, "client"),
    now: Date.now(),
  });
  assert.equal(clientRole.role, "client");
  const remaining = (input.phase === "a" ? 30 : 15) * 60000;
  assert.ok(
    clientRole.expiresAt && clientRole.expiresAt - Date.now() >= remaining,
    "Insufficient original role lifetime; no remint",
  );
  let result: unknown;
  const tokens = [clientRole.token];
  if (state.mode === "perform") {
    const executorRole = openLiveDeviceRole({
      key: secret.admin,
      envelope: envelopes[input.phase],
      expectedFrame: frame(state, current, started.ownership, input.phase),
      now: Date.now(),
    });
    assert.equal(executorRole.role, "executor");
    tokens.push(executorRole.token);
    assert.ok(executorRole.expiresAt && executorRole.expiresAt - Date.now() >= remaining);
    const phaseInput = {
      installed: state.installed,
      context: restrictedJobs(state),
      roles,
      deployment: current,
      seed: started.seed,
      clientRole,
      executorRole,
    };
    if (input.phase === "a") result = await runDeviceContinuityA(phaseInput);
    else {
      assert.ok(previous);
      result = await runDeviceContinuityB(
        phaseInput,
        payload(previous, "device-a.json") as DeviceContinuityA,
      );
    }
  } else {
    assert.ok(started.history);
    assertDeviceEvidenceData(started.history, current);
    const module = (await import(
      pathToFileURL(
        state.installed.resolveExport(`@${state.loaded.candidate.scope}/fortipi-client/node`),
      ).href
    )) as typeof import("../packages/fortipi-client/dist/node.js");
    const client = new module.FortiPiClient({
      endpoint: current.origin,
      credentials: async () => clientRole.token,
    });
    result = await observeDeviceContinuation({
      client,
      devices: started.history,
      deployment: current,
      credential: clientRole.credential,
    });
  }
  roles.assertSanitized(result, tokens);
  const directory = resolve(input.out, input.phase);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await saveJson(resolve(directory, `device-${input.phase}.json`), result);
  await writeMetadata(state, input.phase, directory, current, {
    initialReference: started.artifact.reference,
    ...(aReference ? { aReference } : {}),
  });
  await state.installed.verifyUnchanged();
}

export async function cleanupLiveDevices(input: { installationPath: string; out: string }) {
  const state = await setup(input.installationPath, "cleanup");
  const reference = await findReference("device-ownership", state.loaded, state.context);
  const journal = await readDeviceOwnershipArtifact(
    { loaded: state.loaded, reference, context: state.context },
    githubRequest(process.env.GITHUB_TOKEN),
  );
  const ownership = journal.journal.body;
  assertLiveDeviceOwnership(ownership);
  assert.equal(ownership.candidateSha256, state.loaded.hash);
  assert.equal(ownership.sourceCommit, state.loaded.candidate.sourceCommit);
  assert.equal(ownership.deployment.accountBindingSha256, state.target.accountBindingSha256);
  const declared = object(object(state.target.operator).deployment);
  assert.equal(ownership.deployment.origin, declared.origin);
  assert.equal(ownership.deployment.workerName, declared.name);
  const secret = await keys(state, false);
  const roles = new RoleContext(ownership.deployment.origin, secret.admin);
  const cleanup = await cleanupLiveDeviceRoles({ roles, ownership });
  const directory = resolve(input.out, "cleanup");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  roles.assertSanitized(cleanup);
  await saveJson(resolve(directory, "device-cleanup.json"), cleanup);
  // A failed initial can establish cleanup ownership only; it cannot become a
  // successful device phase or make operate run. Missing prior proofs stay absent.
  const links: Pick<DevicePhaseMetadata, "initialReference" | "aReference" | "bReference"> = {};
  if (journal.conclusion === "success")
    links.initialReference = await findReference("deployment-initial", state.loaded, state.context);
  for (const phase of ["a", "b"] as const) {
    try {
      links[phase === "a" ? "aReference" : "bReference"] = await findReference(
        `device-${phase}`,
        state.loaded,
        state.context,
      );
    } catch {
      /* Missing failed/skipped phase does not erase owned cleanup. */
    }
  }
  await writeMetadata(state, "cleanup", directory, ownership.deployment, links);
  assert.equal(cleanup.state, "complete", "Unknown or pending cleanup blocks acceptance");
}

/** Public data plus exact original phase bytes, after actual API/source/job/ZIP
 * authentication. Re-run this immediately before final retention. */
export async function authenticateDeviceEvidence(input: {
  loaded: LoadedDeviceCandidate;
  context: CurrentDeviceJobContext;
  deployment: DeploymentIdentity;
}): Promise<{ devices: DeviceEvidenceData; phases: DevicePhaseArtifact[] }> {
  assert.equal(input.context.job, "operate");
  assertDeployment(input.deployment);
  await authorizeCurrentDeviceJob(input, githubRequest(process.env.GITHUB_TOKEN));
  const started = await initial(input.loaded, input.context);
  const phases: DevicePhaseArtifact[] = [started.artifact];
  const links = { initial: started.artifact.reference } as {
    initial: ArtifactReference;
    a?: ArtifactReference;
    b?: ArtifactReference;
  };
  for (const phase of ["a", "b", "cleanup"] as const) {
    const reference = await findReference(`device-${phase}`, input.loaded, input.context);
    const artifact = await readDevicePhaseArtifact(
      { ...started.input, phase, reference, expectedLinks: { ...links } },
      githubRequest(process.env.GITHUB_TOKEN),
    );
    phases.push(artifact);
    if (phase !== "cleanup") links[phase] = reference;
  }
  const [original, a, b, cleanup] = phases;
  assert.ok(original && a && b && cleanup);
  const currentCleanup = completeCleanup(payload(cleanup, "device-cleanup.json"));
  let devices: DeviceEvidenceData;
  if (input.context.operation === "deploy") {
    devices = {
      schemaVersion: 1,
      initial: { deployment: started.deployment, seed: started.seed },
      a: payload(a, "device-a.json") as DeviceContinuityA,
      b: object(payload(b, "device-b.json")).observation as DeviceContinuityBObservation,
      cleanup: currentCleanup,
      references: {
        initial: original.reference,
        a: a.reference,
        b: b.reference,
        cleanup: cleanup.reference,
      },
    };
  } else {
    assert.ok(started.history);
    devices = started.history;
    assert.equal(started.ownership.kind, "read");
    assert.equal(started.ownership.roles.length, 1);
    const carried = started.ownership.roles[0];
    assert.ok(carried?.credential);
    assert.equal(carried.name, "client");
    assert.equal(carried.issuance, "known");
    assert.equal(currentCleanup.length, 1);
    assert.deepEqual(currentCleanup[0]?.credential, carried.credential);
    for (const [artifact, path] of [
      [a, "device-a.json"],
      [b, "device-b.json"],
    ] as const) {
      const observation = object(object(payload(artifact, path)).observation);
      assert.equal(observation.freshReplacement, false);
      assert.equal(observation.freshInterruption, false);
      assert.equal(observation.currentProviderDeploymentId, input.deployment.deploymentId);
      assert.equal(observation.currentWorkerVersionId, input.deployment.workerVersionId);
      assert.deepEqual(observation.references, devices.references);
    }
    await authenticateHistoricalDevices(input.loaded, input.deployment, devices);
  }
  assertDeviceEvidenceData(devices, input.deployment);
  return { devices, phases };
}

export async function retainDevicePhaseBytes(
  directory: string,
  result: Awaited<ReturnType<typeof authenticateDeviceEvidence>>,
) {
  await mkdir(directory, { mode: 0o700 });
  for (const phase of result.phases) {
    const root = resolve(directory, phase.metadata.phase);
    await mkdir(root, { mode: 0o700 });
    const metadataName =
      phase.metadata.phase === "initial" ? "device-initial.json" : "device-phase.json";
    const bytes = Buffer.from(phase.metadataBase64, "base64");
    assert.equal(sha256(bytes), phase.metadataSha256);
    await writeFile(resolve(root, metadataName), bytes, { flag: "wx", mode: 0o600 });
    for (const [name, selected] of Object.entries(phase.payloads)) {
      const member = Buffer.from(selected.base64, "base64");
      assert.equal(member.length, selected.record.size);
      assert.equal(sha256(member), selected.record.sha256);
      assert.ok(!name.includes("/") && name.endsWith(".json"));
      await writeFile(resolve(root, name), member, { flag: "wx", mode: 0o600 });
    }
  }
  await saveJson(resolve(directory, "device-evidence.json"), result.devices);
  await saveJson(
    resolve(directory, "references.json"),
    result.phases.map((phase) => ({
      phase: phase.metadata.phase,
      reference: phase.reference,
      metadataSha256: phase.metadataSha256,
    })),
  );
}

export async function observeInitialDeployment(input: {
  installationPath: string;
  proofsPath: string;
  out: string;
}) {
  const state = await setup(input.installationPath, "operate");
  const started = await initial(state.loaded, state.context);
  const secret = await keys(state);
  const current = await observe(state, started.cli, secret);
  assert.deepEqual(stable(current), stable(started.deployment));
  if (state.mode === "verify-existing") {
    assert.ok(started.history);
    const history = await originalHistory(state, input.proofsPath, current);
    assert.deepEqual(history, started.history);
  }
  await saveJson(input.out, current);
  await saveJson(`${input.out}.cli.json`, started.cli);
}

if (import.meta.main) {
  try {
    const args = cliArgs(),
      operation = process.argv[2];
    const installationPath = args.installation ? resolve(string(args.installation)) : undefined;
    const out = resolve(string(args.out));
    if (operation === "install")
      await installLiveDeviceCandidate({
        candidatePath: resolve(string(args.candidate)),
        targetPath: resolve(string(args.target)),
        out,
      });
    else {
      assert.ok(installationPath);
      if (operation === "initial")
        await initializeLiveDevices({
          installationPath,
          out,
          deploymentPath: resolve(string(args.deployment)),
          proofsPath: resolve(string(args.proofs)),
        });
      else if (operation === "initial-metadata")
        await finalizeInitialDevices({
          installationPath,
          out,
          custodyId: integer(Number(args["custody-id"])),
        });
      else if (operation === "phase") {
        assert.ok(args.phase === "a" || args.phase === "b");
        await runLiveDevicePhase({ installationPath, out, phase: args.phase });
      } else if (operation === "cleanup") await cleanupLiveDevices({ installationPath, out });
      else if (operation === "observe")
        await observeInitialDeployment({
          installationPath,
          out,
          proofsPath: resolve(string(args.proofs)),
        });
      else if (operation === "collect") {
        const state = await setup(installationPath, "operate");
        const deployment = await readJson(resolve(string(args.deployment)));
        assertDeployment(deployment);
        freshness(deployment.checkedAt, 0.25);
        const result = await authenticateDeviceEvidence({
          loaded: state.loaded,
          context: state.context,
          deployment,
        });
        await saveJson(out, result.devices);
      } else throw new Error("Unknown device phase operation");
    }
  } catch {
    process.stderr.write(
      "Device phase unavailable or inconsistent; deployment verification remains incomplete.\n",
    );
    process.exitCode = 1;
  }
}
