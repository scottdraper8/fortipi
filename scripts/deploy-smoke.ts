import assert from "node:assert/strict";
import { cp, mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { operatorConfig } from "../packages/fortipi-cli/dist/config.js";
import { validateRecoveryRetention } from "./application-recovery-retention.ts";
import { repository } from "./build-workspaces.ts";
import { operatorConfirmedFreePlan } from "./operator-free-plan.ts";
import {
  childEnvironment,
  execute,
  installCandidate,
  loadWorkflowCandidate,
  producer,
  resolveCandidateReadContext,
} from "./prepare-release.ts";
import {
  type ArtifactReference,
  assertDeployment,
  assertGate,
  type CandidateManifest,
  canonicalJson,
  cliArgs,
  type DeploymentIdentity,
  digest,
  freshness,
  type GateReceipt,
  githubRequest,
  integer,
  inventory,
  object,
  privilegedCheckout,
  readJson,
  regularBytes,
  safePath,
  saveJson,
  sha256,
  string,
  trustedMain,
  verifyPayload,
  verifyProducer,
} from "./verify-release-gates.ts";

export interface TargetDescriptor {
  schemaVersion: 1;
  accountBindingSha256: string;
  slot?: "production" | "paid-validation";
  backend: "free" | "cloud-js" | "linux";
  operator: unknown;
  containerApplicationId?: string;
  paidAuthorized?: true;
}
export function assertTarget(value: unknown): asserts value is TargetDescriptor {
  const t = object(value);
  assert.equal(t.schemaVersion, 1);
  digest(t.accountBindingSha256);
  assert.ok(["free", "cloud-js", "linux"].includes(string(t.backend)));
  assert.ok(
    Object.keys(t).every((k) =>
      [
        "schemaVersion",
        "accountBindingSha256",
        "slot",
        "backend",
        "operator",
        "containerApplicationId",
        "paidAuthorized",
      ].includes(k),
    ),
    "Unexpected target descriptor field",
  );
  operatorConfig(t.operator);
  assert.ok(
    t.slot === undefined || t.slot === "production" || t.slot === "paid-validation",
    "Unknown protected deployment slot",
  );
  const operator = object(t.operator);
  const deployment = object(operator.deployment);
  const origin = new URL(string(deployment.origin));
  assert.equal(origin.protocol, "https:");
  assert.ok(
    origin.hostname.endsWith(".workers.dev") &&
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.port &&
      !origin.search &&
      !origin.hash,
    "Only bounded workers.dev targets are supported",
  );
  assert.ok(
    !Object.hasOwn(deployment, "accountId"),
    "Deployment config must omit the secret account ID",
  );
  const runtime = object(operator.runtime);
  const infrastructure = object(runtime.infrastructure);
  const execution = object(runtime.execution);
  if (t.backend === "free") {
    assert.ok(infrastructure.accountPlan === "free" || infrastructure.accountPlan === "unknown");
    assert.equal(infrastructure.profile, "free");
    assert.equal(execution.kind, "native");
    assert.equal(t.paidAuthorized, undefined);
    assert.equal(t.containerApplicationId, undefined);
  } else {
    assert.equal(t.paidAuthorized, true, "Explicit paid target authority required; never upgrade");
    assert.equal(infrastructure.accountPlan, "paid");
    assert.equal(execution.kind, t.backend);
    if (t.backend === "linux")
      assert.match(string(t.containerApplicationId), /^[a-zA-Z0-9-]{1,128}$/);
  }
}
export type CloudflareRead = (path: string) => Promise<unknown>;
export function cloudflareRequest(
  account: string | undefined,
  accountBindingSha256: string,
  token: string,
  transport: typeof fetch = fetch,
): CloudflareRead {
  assert.ok(
    typeof account === "string" && /^[a-f0-9]{32}$/.test(account),
    "Production account identity unavailable",
  );
  assert.ok(sha256(account) === accountBindingSha256, "Production account hash binding mismatch");
  let count = 0;
  return async (path) => {
    assert.ok(
      (path === "/workers/subdomain" ||
        path === "/workers/durable_objects/namespaces?page=1&per_page=1000" ||
        /^\/(?:workers\/scripts|containers\/applications)\//.test(path)) &&
        !path.includes("..") &&
        ++count <= 32,
    );
    let response: Response;
    try {
      response = await transport(
        `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new Error("Cloudflare metadata transport unavailable");
    }
    assert.ok(response.ok, `Cloudflare metadata HTTP ${response.status}`);
    let value: Record<string, unknown>;
    try {
      value = object(await response.json());
    } catch {
      throw new Error("Cloudflare metadata JSON unavailable");
    }
    assert.equal(value.success, true, "Cloudflare metadata unavailable");
    if (path.startsWith("/containers/applications/")) {
      const app = object(value.result);
      assert.ok(app.account_id === account, "Container account binding mismatch");
      const image = object(app.configuration).image;
      assert.ok(typeof image === "string");
      const match = image.match(/@(sha256:[a-f0-9]{64})$/);
      assert.ok(match, "Actual selected image digest uninspectable");
      return {
        accountBindingSha256,
        name: app.name,
        imageDigest: match[1],
      };
    }
    return value.result;
  };
}
/** Read the active rollout, selected version metadata and public configuration; retain no raw API bodies. */
export async function observeDeployment(
  candidate: CandidateManifest,
  candidateHash: string,
  target: TargetDescriptor,
  preparedDirectory: string,
  cliReceipt: unknown,
  request: CloudflareRead,
  transport: typeof fetch = fetch,
  adminToken?: string,
): Promise<DeploymentIdentity> {
  assertTarget(target);
  digest(candidateHash);
  const cli = object(cliReceipt);
  assert.deepEqual(
    Object.keys(cli).sort(),
    [
      "workerName",
      "origin",
      "targets",
      "workerVersionId",
      "sourceCommit",
      "packageVersion",
      "assetManifestSha256",
      "configSha256",
    ].sort(),
    "Unexpected CLI receipt fields",
  );
  const operator = object(target.operator);
  const deployment = object(operator.deployment);
  const config = object(operator.runtime);
  assert.equal(cli.workerName, deployment.name);
  assert.equal(cli.origin, deployment.origin);
  assert.equal(cli.sourceCommit, candidate.sourceCommit);
  assert.equal(cli.packageVersion, candidate.version);
  assert.equal(cli.assetManifestSha256, candidate.assetManifestSha256);
  assert.equal(cli.configSha256, sha256(canonicalJson(config)));
  assert.match(string(cli.workerVersionId), /^[a-f0-9-]{36}$/);
  const prepared = object(await readJson(resolve(preparedDirectory, "prepare-receipt.json")));
  assert.equal(prepared.assetManifestSha256, candidate.assetManifestSha256);
  assert.equal(prepared.sourceCommit, candidate.sourceCommit);
  assert.deepEqual(prepared.operator, target.operator);
  const path = `/workers/scripts/${string(deployment.name)}`;
  const accountSubdomain = string(object(await request("/workers/subdomain")).subdomain);
  assert.match(accountSubdomain, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(
    deployment.origin,
    `https://${string(deployment.name)}.${accountSubdomain}.workers.dev`,
    "Application origin is not this account's Worker route",
  );
  assert.equal(
    object(await request(`${path}/subdomain`)).enabled,
    true,
    "Worker route is disabled",
  );
  const rollouts = object(await request(`${path}/deployments`));
  assert.ok(Array.isArray(rollouts.deployments) && rollouts.deployments.length > 0);
  const active = object(rollouts.deployments[0]);
  assert.equal(active.strategy, "percentage");
  assert.deepEqual(
    active.versions,
    [{ version_id: cli.workerVersionId, percentage: 100 }],
    "Split or stale active rollout",
  );
  const version = object(await request(`${path}/versions/${string(cli.workerVersionId)}`));
  assert.equal(version.id, cli.workerVersionId);
  const resources = object(version.resources);
  const script = object(resources.script);
  assert.ok(Array.isArray(script.named_handlers));
  const names = script.named_handlers.map((v) => object(v).name);
  for (const name of ["ControlPlane", "AgentSession", "WorkspaceObject", "WorkspaceProxy"])
    assert.ok(names.includes(name), "Missing actual Worker/DO export");
  const runtime = object(resources.script_runtime);
  const wrangler = object(await readJson(resolve(preparedDirectory, "wrangler.json")));
  assert.equal(String(runtime.compatibility_date).slice(0, 10), wrangler.compatibility_date);
  assert.deepEqual(runtime.compatibility_flags, wrangler.compatibility_flags);
  assert.ok(Array.isArray(wrangler.migrations));
  assert.equal(
    runtime.migration_tag,
    object(wrangler.migrations.at(-1)).tag,
    "Migration identity mismatch",
  );
  const declared = object(runtime.exports);
  for (const name of ["ControlPlane", "AgentSession", "WorkspaceObject"]) {
    const definition = object(declared[name]);
    assert.equal(definition.type, "durable-object");
    assert.equal(definition.storage, "sqlite");
    assert.equal(definition.state === undefined ? "created" : definition.state, "created");
  }
  assert.ok(Array.isArray(resources.bindings), "Uninspectable version bindings");
  const bindings = resources.bindings.map(object);
  const expected = object(wrangler.durable_objects);
  assert.ok(Array.isArray(expected.bindings));
  for (const desired of expected.bindings.map(object)) {
    const binding = bindings.filter((b) => b.name === desired.name);
    assert.equal(binding.length, 1);
    assert.equal(binding[0]?.type, "durable_object_namespace");
    assert.equal(binding[0]?.class_name, desired.class_name);
  }
  const variable = bindings.filter((b) => b.name === "FORTIPI_CONFIG");
  assert.equal(variable.length, 1);
  assert.equal(variable[0]?.type, "json");
  const actual =
    typeof variable[0]?.json === "string" ? JSON.parse(variable[0].json) : variable[0]?.json;
  assert.equal(
    canonicalJson(actual),
    canonicalJson(config),
    "Active runtime configuration mismatch",
  );
  const expectedOrigins = deployment.allowedOrigins ?? [];
  assert.deepEqual(
    object(wrangler.vars).FORTIPI_ALLOWED_ORIGINS ?? [],
    expectedOrigins,
    "Prepared browser Origin allowlist mismatch",
  );
  const origins = bindings.filter((binding) => binding.name === "FORTIPI_ALLOWED_ORIGINS");
  assert.ok(origins.length <= 1, "Duplicate browser Origin binding");
  if (origins.length === 0) assert.deepEqual(expectedOrigins, [], "Missing browser Origin binding");
  else {
    assert.equal(origins[0]?.type, "json", "Invalid browser Origin binding type");
    const observed =
      typeof origins[0]?.json === "string" ? JSON.parse(origins[0].json) : origins[0]?.json;
    assert.deepEqual(observed, expectedOrigins, "Active browser Origin allowlist mismatch");
  }
  assert.ok(bindings.some((b) => b.type === "ai" && b.name === "AI"));
  const loaders = bindings.filter((b) => b.type === "worker_loader");
  assert.equal(loaders.length, target.backend === "cloud-js" ? 1 : 0);
  assert.equal(Boolean(wrangler.worker_loaders), target.backend === "cloud-js");
  assert.equal(Boolean(wrangler.containers), target.backend === "linux");
  let imageDigest: string | null = null;
  if (target.backend === "linux") {
    const expectedContainer = string(object(declared.LinuxContainerHost).container);
    const application = object(
      await request(`/containers/applications/${string(target.containerApplicationId)}`),
    );
    assert.equal(application.accountBindingSha256, target.accountBindingSha256);
    assert.equal(application.name, expectedContainer);
    imageDigest = string(application.imageDigest);
    assert.equal(imageDigest, object(config.execution).imageDigest);
    assert.equal(
      imageDigest,
      candidate.image.builtManifestDigest,
      "Selected image differs from qualified candidate",
    );
  } else
    assert.ok(
      !declared.LinuxContainerHost || !object(declared.LinuxContainerHost).container,
      "Unexpected paid container export",
    );
  const health = await transport(`${string(deployment.origin)}/health`, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(health.status, 200);
  const publicHealth = object(await health.json());
  assert.equal(publicHealth.status, "ok");
  assert.equal(publicHealth.protocolVersion, "1.0");
  assert.ok(adminToken, "Application admin role required for redacted configuration version");
  const configResponse = await transport(`${string(deployment.origin)}/v1/admin/configuration`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(configResponse.status, 200);
  const publicConfig = object(await configResponse.json());
  assert.equal(
    canonicalJson(publicConfig),
    canonicalJson(config),
    "Current public configuration differs from prepared runtime",
  );
  const planProvenance =
    target.backend === "free" ? operatorConfirmedFreePlan(target.accountBindingSha256) : undefined;
  const result: DeploymentIdentity = {
    schemaVersion: 1,
    candidateSha256: candidateHash,
    sourceCommit: candidate.sourceCommit,
    accountBindingSha256: target.accountBindingSha256,
    slot: target.slot ?? "production",
    workerName: string(deployment.name),
    origin: string(deployment.origin),
    workerVersionId: string(cli.workerVersionId),
    deploymentId: string(active.id),
    versions: [{ versionId: string(cli.workerVersionId), percentage: 100 }],
    configSha256: sha256(await regularBytes(resolve(preparedDirectory, "wrangler.json"))),
    runtimeConfigSha256: sha256(canonicalJson(config)),
    assetManifestSha256: candidate.assetManifestSha256,
    publicConfigurationVersion: Number(publicConfig.version),
    ...(planProvenance ? { planProvenance } : {}),
    capabilities: {
      plan: target.backend === "free" ? (planProvenance ? "free" : "unknown") : "paid",
      loaders: target.backend === "cloud-js",
      containers: target.backend === "linux",
    },
    backend: target.backend,
    imageDigest,
    checkedAt: new Date().toISOString(),
  };
  assertDeployment(result);
  return result;
}
export async function installDeployment(
  candidatePath: string,
  targetPath: string,
  directory: string,
  out: string,
): Promise<void> {
  const { candidate } = await loadWorkflowCandidate(candidatePath);
  assert.ok(candidate.publishable, "Synthetic artifacts cannot deploy");
  const target = await readJson(targetPath);
  assertTarget(target);
  const installed = await installCandidate(
    candidatePath,
    directory,
    ["fortipi-cli"],
    false,
    await resolveCandidateReadContext(candidatePath),
  );
  const config = resolve(directory, "operator.json");
  await saveJson(config, target.operator);
  const prepared = resolve(directory, "prepared");
  const result = await execute(
    process.execPath,
    [
      installed.cliBin,
      "prepare",
      "--config",
      config,
      "--directory",
      prepared,
      "--non-interactive",
      "--json",
    ],
    installed.consumer,
    childEnvironment(),
    120000,
  );
  assert.equal(result.code, 0);
  const receipt = object(JSON.parse(result.stdout));
  assert.equal(receipt.assetManifestSha256, candidate.assetManifestSha256);
  await saveJson(out, {
    schemaVersion: 1,
    ...installed,
    prepared,
    target,
    candidatePath: resolve(candidatePath),
  });
}
export async function operateDeployment(
  operation: "deploy" | "verify",
  installationPath: string,
  out: string,
  confirmation: string,
  proofsPath: string,
  previous?: string,
): Promise<void> {
  const installed = object(await readJson(installationPath));
  const candidatePath = string(installed.candidatePath);
  const { candidate, hash } = await loadWorkflowCandidate(candidatePath);
  assert.equal(hash, installed.candidateSha256);
  await privilegedCheckout(candidate);
  await trustedMain(candidate, githubRequest(process.env.GITHUB_TOKEN));
  const gate = await execute(
    process.execPath,
    [
      "scripts/verify-release-gates.ts",
      "deployment",
      "--candidate",
      candidatePath,
      "--proofs",
      proofsPath,
    ],
    repository,
    childEnvironment({ GITHUB_TOKEN: process.env.GITHUB_TOKEN }),
    300000,
  );
  assert.equal(gate.code, 0, "Deployment prerequisites unavailable");
  const target = installed.target;
  assertTarget(target);
  const _deployment = object(object(target.operator).deployment);
  assert.equal(
    confirmation,
    `${operation} ${candidate.tag} ${candidate.sourceCommit} ${candidate.scope}`,
  );
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  assert.ok(
    typeof account === "string" && sha256(account) === target.accountBindingSha256,
    "Production account hash binding mismatch",
  );
  assert.ok(!(await realpath(string(installed.consumer))).startsWith(`${repository}${sep}`));
  let cli: unknown;
  if (operation === "deploy") {
    await trustedMain(candidate, githubRequest(process.env.GITHUB_TOKEN));
    const result = await execute(
      process.execPath,
      [
        string(installed.cliBin),
        "deploy",
        "--directory",
        string(installed.prepared),
        "--bootstrap",
        "existing",
        "--non-interactive",
        "--json",
      ],
      string(installed.consumer),
      childEnvironment({
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: account,
        FORTIPI_ADMIN_TOKEN: process.env.FORTIPI_ADMIN_TOKEN,
      }),
      180000,
    );
    assert.equal(result.code, 0, "Installed deployment failed/uncertain; no rollback inferred");
    cli = JSON.parse(result.stdout);
    assert.deepEqual(
      Object.keys(object(cli)).sort(),
      [
        "workerName",
        "origin",
        "targets",
        "workerVersionId",
        "sourceCommit",
        "packageVersion",
        "assetManifestSha256",
        "configSha256",
      ].sort(),
      "Unexpected CLI receipt fields; nothing persisted",
    );
    await saveJson(`${out}.cli.json`, cli);
  } else {
    assert.ok(previous, "Verification requires the prior exact retained version receipt");
    cli = await readJson(previous);
    const bytes = await regularBytes(previous);
    const bundle = object(await readJson(proofsPath));
    assert.ok(Array.isArray(bundle.proofs));
    let matched = false;
    for (const raw of bundle.proofs) {
      const proof = object(raw);
      const directory = string(proof.directory);
      const receipt = await readJson(resolve(directory, "gate.json"));
      assertGate(receipt);
      if (
        receipt.kind !== "live" ||
        !receipt.files.some((file) => file.sha256 === sha256(bytes) && file.size === bytes.length)
      )
        continue;
      assert.equal(receipt.candidateSha256, hash);
      assert.equal(receipt.sourceCommit, candidate.sourceCommit);
      await verifyProducer(
        candidate,
        "live",
        receipt.producer,
        object(proof.artifact) as unknown as ArtifactReference,
        githubRequest(process.env.GITHUB_TOKEN),
        Date.now(),
        sha256(await regularBytes(resolve(directory, "gate.json"))),
      );
      await verifyPayload(directory, receipt.files, ["gate.json"]);
      matched = true;
    }
    assert.ok(matched, "Prior version receipt is not retained in a trusted live producer");
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert.ok(token);
  const identity = await observeDeployment(
    candidate,
    hash,
    target,
    string(installed.prepared),
    cli,
    cloudflareRequest(process.env.CLOUDFLARE_ACCOUNT_ID, target.accountBindingSha256, token),
    fetch,
    process.env.FORTIPI_ADMIN_TOKEN,
  );
  await saveJson(out, identity);
}
/** A fresh observation may refresh time, never silently replace the target on
 * which application claims were observed. Recovery needs its explicit lineage. */
export function assertObservedDeployment(
  observations: DeploymentIdentity[],
  deployment: DeploymentIdentity,
): void {
  assert.equal(observations.length, 1, "One actual application target required");
  const original = observations[0];
  assert.ok(original);
  assertDeployment(original);
  assertDeployment(deployment);
  const stable = ({ checkedAt: _time, ...identity }: DeploymentIdentity) => identity;
  assert.deepEqual(
    stable(original),
    stable(deployment),
    "Evidence target changed without authenticated recovery",
  );
}

/** Bind owner10's detailed results to owner9's actual installed deployment observation. */
export async function retainEvidence(
  candidatePath: string,
  claimsDirectory: string,
  deploymentPath: string,
  cliPath: string,
  out: string,
  kind: "live" | "independent",
  readinessOut: string,
  recovery?: { factsPath: string; currentReceiptPath: string; proofsPath: string },
  devicesPath?: string,
): Promise<void> {
  const loaded = await loadWorkflowCandidate(candidatePath);
  const child = await readJson(resolve(claimsDirectory, "gate.json"));
  assertGate(child);
  assert.equal(child.candidateSha256, loaded.hash);
  assert.equal(child.sourceCommit, loaded.candidate.sourceCommit);
  await verifyPayload(claimsDirectory, child.files, ["gate.json"]);
  const deployment = await readJson(deploymentPath);
  assertDeployment(deployment);
  assert.equal(deployment.candidateSha256, loaded.hash);
  freshness(deployment.checkedAt, 0.25);
  if (recovery)
    await validateRecoveryRetention({
      candidate: loaded.candidate,
      candidateSha256: loaded.hash,
      kind,
      child,
      claimsDirectory,
      deployment,
      originalCliPath: cliPath,
      ...recovery,
      request: githubRequest(process.env.GITHUB_TOKEN),
    });
  else assertObservedDeployment(child.deployments, deployment);
  const devices = devicesPath
    ? await (async () => {
        const helpers = await import("./live-device-evidence.ts");
        const { currentDeviceJobContext } = await import("./device-phase-artifacts.ts");
        const result = await helpers.authenticateDeviceEvidence({
          loaded,
          context: currentDeviceJobContext(),
          deployment,
        });
        const bytes = await regularBytes(devicesPath, 1_048_576);
        assert.equal(bytes.toString("utf8"), `${canonicalJson(result.devices)}\n`);
        const row = child.claims.find((claim) => claim.id === "cloud-local-portability");
        assert.ok(row && row.outcome === "pass");
        const record = object(await readJson(resolve(claimsDirectory, row.result.path)));
        assert.deepEqual(object(record.observation).references, result.devices.references);
        return { helpers, result };
      })()
    : undefined;
  await mkdir(out, { mode: 0o700 });
  await cp(claimsDirectory, resolve(out, "claims"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await cp(deploymentPath, resolve(out, "deployment.json"));
  await cp(cliPath, resolve(out, "deployment.cli.json"));
  if (recovery) {
    await cp(recovery.currentReceiptPath, resolve(out, "deployment.provider-version.json"));
    await cp(recovery.factsPath, resolve(out, "recovery-link.json"));
  }
  if (devices)
    await devices.helpers.retainDevicePhaseBytes(resolve(out, "device-phases"), devices.result);
  const sourceProducer = await producer(repository, true, "deploy.yml");
  const result: GateReceipt = {
    ...child,
    kind,
    producer: sourceProducer,
    claims: child.claims.map((c) => ({
      ...c,
      result: { ...c.result, path: `claims/${c.result.path}` },
    })),
    deployments: [deployment],
    files: await inventory(out),
  };
  assertGate(result);
  await saveJson(resolve(out, "gate.json"), result);
  await mkdir(readinessOut, { mode: 0o700 });
  await cp(deploymentPath, resolve(readinessOut, "deployment.json"));
  await cp(cliPath, resolve(readinessOut, "deployment.cli.json"));
  if (recovery) {
    await cp(
      recovery.currentReceiptPath,
      resolve(readinessOut, "deployment.provider-version.json"),
    );
    await cp(recovery.factsPath, resolve(readinessOut, "recovery-link.json"));
  }
  const files = await inventory(readinessOut);
  const record = files.find((f) => f.path === "deployment.json");
  assert.ok(record);
  const ready: GateReceipt = {
    schemaVersion: 1,
    kind: "readiness",
    candidateSha256: loaded.hash,
    sourceCommit: loaded.candidate.sourceCommit,
    scope: loaded.candidate.scope,
    producer: sourceProducer,
    checkedAt: deployment.checkedAt,
    claims: [{ id: "current-deployment", outcome: "pass", result: record }],
    platforms: [],
    deployments: [deployment],
    files,
  };
  assertGate(ready);
  await saveJson(resolve(readinessOut, "gate.json"), ready);
}
export async function prepareReadiness(
  candidatePath: string,
  proofsPath: string,
  targetsPath: string,
  directory: string,
  out: string,
): Promise<void> {
  const loaded = await loadWorkflowCandidate(candidatePath);
  const bundle = object(await readJson(proofsPath));
  assert.ok(Array.isArray(bundle.proofs));
  const descriptors = await readJson(targetsPath);
  assert.ok(Array.isArray(descriptors));
  assert.equal(descriptors.length, 1, "Each readiness job uses exactly one protected target slot");
  await mkdir(directory, { mode: 0o700 });
  const installations: { path: string; previous: string }[] = [];
  for (const raw of descriptors) {
    const descriptor = object(raw);
    const target = descriptor.target;
    assertTarget(target);
    const previous = object(descriptor.previous);
    integer(previous.artifactId);
    const file = safePath(string(previous.path));
    const proof: Record<string, unknown> | undefined = bundle.proofs
      .map(object)
      .find((p) => object(p.artifact).artifactId === previous.artifactId);
    assert.ok(proof, "Unknown prior deployment producer");
    const receiptPath = resolve(string(proof.directory), file);
    const targetPath = resolve(directory, `${target.backend}.json`);
    await saveJson(targetPath, target);
    const installation = resolve(directory, `${target.backend}-installation.json`);
    await installDeployment(
      candidatePath,
      targetPath,
      resolve(directory, target.backend),
      installation,
    );
    installations.push({ path: installation, previous: receiptPath });
  }
  await saveJson(out, {
    schemaVersion: 1,
    candidateSha256: loaded.hash,
    candidatePath: resolve(candidatePath),
    proofsPath: resolve(proofsPath),
    installations,
  });
}
export async function refreshReadiness(contextPath: string, out: string): Promise<void> {
  const context = object(await readJson(contextPath));
  const loaded = await loadWorkflowCandidate(string(context.candidatePath));
  assert.equal(context.candidateSha256, loaded.hash);
  assert.ok(Array.isArray(context.installations));
  const deployments: DeploymentIdentity[] = [];
  for (const value of context.installations) {
    const item = object(value);
    const path = `${string(item.path)}.observed.json`;
    await operateDeployment(
      "verify",
      string(item.path),
      path,
      `verify ${loaded.candidate.tag} ${loaded.candidate.sourceCommit} ${loaded.candidate.scope}`,
      string(context.proofsPath),
      string(item.previous),
    );
    const deployment = await readJson(path);
    assertDeployment(deployment);
    deployments.push(deployment);
  }
  assert.equal(
    deployments.length,
    1,
    "Each job observes one target; the release gate requires all three",
  );
  await saveJson(out, {
    schemaVersion: 1,
    candidateSha256: loaded.hash,
    sourceCommit: loaded.candidate.sourceCommit,
    checkedAt: new Date().toISOString(),
    deployments,
  });
}
if (import.meta.main) {
  try {
    const a = cliArgs();
    const operation = process.argv[2];
    if (operation === "previous") {
      const previous = object(JSON.parse(string(process.env.PREVIOUS_REFERENCE, 60000)));
      const bundle = object(await readJson(string(a.proofs)));
      assert.ok(Array.isArray(bundle.proofs));
      const selected = bundle.proofs
        .map(object)
        .find((p) => object(p.artifact).artifactId === integer(previous.artifactId));
      assert.ok(selected);
      const path = resolve(string(selected.directory), safePath(string(previous.path)));
      await regularBytes(path);
      await writeFile(string(process.env.GITHUB_ENV), `FORTIPI_PREVIOUS_CLI_RECEIPT=${path}\n`, {
        flag: "a",
      });
    } else if (operation === "operate") {
      const mode = process.env.OPERATION;
      assert.ok(mode === "deploy" || mode === "verify");
      await operateDeployment(
        mode,
        string(a.installation),
        string(a.out),
        string(a.confirm),
        string(a.proofs),
        process.env.FORTIPI_PREVIOUS_CLI_RECEIPT,
      );
      if (mode === "verify") {
        assert.ok(process.env.FORTIPI_PREVIOUS_CLI_RECEIPT);
        await cp(process.env.FORTIPI_PREVIOUS_CLI_RECEIPT, `${string(a.out)}.cli.json`);
      }
    } else if (operation === "observe-installed") {
      const installed = object(await readJson(string(a.installation)));
      const loaded = await loadWorkflowCandidate(string(installed.candidatePath));
      await privilegedCheckout(loaded.candidate);
      await trustedMain(loaded.candidate, githubRequest(process.env.GITHUB_TOKEN));
      const target = installed.target;
      assertTarget(target);
      const token = process.env.CLOUDFLARE_API_TOKEN;
      assert.ok(token);
      const observation = await observeDeployment(
        loaded.candidate,
        loaded.hash,
        target,
        string(installed.prepared),
        await readJson(string(a.cli)),
        cloudflareRequest(process.env.CLOUDFLARE_ACCOUNT_ID, target.accountBindingSha256, token),
        fetch,
        process.env.FORTIPI_ADMIN_TOKEN,
      );
      await saveJson(string(a.out), observation, false);
    } else if (operation === "install")
      await installDeployment(
        string(a.candidate),
        string(a.target),
        string(a.directory),
        string(a.out),
      );
    else if (operation === "deploy" || operation === "verify")
      await operateDeployment(
        operation,
        string(a.installation),
        string(a.out),
        string(a.confirm),
        string(a.proofs),
        a.previous,
      );
    else if (operation === "evidence") {
      assert.ok(a.devices, "Actual device phase evidence is required");
      const { runLiveRecoveryEvidence } = await import("./live-recovery-evidence.ts");
      await runLiveRecoveryEvidence({
        candidatePath: resolve(string(a.candidate)),
        installationPath: resolve(string(a.installation)),
        fixture: resolve(string(a.fixture)),
        out: resolve(string(a.out)),
        deploymentPath: resolve(string(a.deployment)),
        proofsPath: resolve(string(a.proofs)),
        ...(a.devices ? { devicesPath: resolve(string(a.devices)) } : {}),
      });
    } else if (operation === "retain" || operation === "retain-operation") {
      if (operation === "retain-operation")
        assert.ok(a.devices, "Actual device phase evidence is required");
      const kind =
        operation === "retain-operation"
          ? process.env.OPERATION === "deploy"
            ? "live"
            : "independent"
          : a.kind;
      assert.ok(kind === "live" || kind === "independent");
      await retainEvidence(
        string(a.candidate),
        string(a.claims),
        string(a.deployment),
        operation === "retain-operation" ? `${string(a.deployment)}.cli.json` : string(a.cli),
        string(a.out),
        kind,
        string(a.readiness),
        a.recovery
          ? {
              factsPath: resolve(string(a.recovery)),
              currentReceiptPath: resolve(string(a.current)),
              proofsPath: resolve(string(a.proofs)),
            }
          : undefined,
        a.devices ? resolve(string(a.devices)) : undefined,
      );
    } else if (operation === "prepare-readiness")
      await prepareReadiness(
        string(a.candidate),
        string(a.proofs),
        string(a.targets),
        string(a.directory),
        string(a.out),
      );
    else if (operation === "readiness") await refreshReadiness(string(a.context), string(a.out));
    else throw new Error("Expected install, deploy, verify or evidence");
  } catch {
    console.error(
      "Deployment identity or required proof unavailable/invalid; deployment/verification remains incomplete.",
    );
    process.exitCode = 1;
  }
}
