import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  assertDeployment,
  assertProducer,
  type CandidateManifest,
  type DeploymentIdentity,
  type GateReceipt,
  integratedClaims,
  inventory,
  liveClaims,
  type Producer,
  REPOSITORY,
  regularBytes,
  saveJson,
  sha256,
} from "../../scripts/verify-release-gates.ts";
import { assertDeviceEvidenceData, type DeviceEvidenceData } from "./device-observer.ts";

export type Mode = "local" | "native" | "live";
export interface EvidenceInput {
  mode: Mode;
  candidateManifest: string;
  deploymentReceipt?: string;
  devicesReceipt?: string;
  fixture: string;
  out: string;
}
export interface Identity {
  sourceCommit: string;
  candidateSha256: string;
  assetManifestSha256: string;
  imageBuiltManifestDigest: string;
  lockSha256: string;
  toolchainPolicySha256: string;
  fixtureSha256: string;
  producer: Producer;
  platform: NodeJS.Platform;
  architecture: string;
  node: string;
  seed: 1010;
  deployments: DeploymentIdentity[];
}
export interface ClaimResult {
  id: string;
  outcome: "pass" | "fail" | "unavailable" | "timeout";
  identity: Identity;
  command: string[];
  observation: Record<string, unknown>;
  oracle: string;
  sensitivity: string[];
  limitations: string[];
}
export interface ScenarioEvidence {
  observation: Record<string, unknown>;
  oracle: string;
  sensitivity: string[];
  limitations: string[];
}
/** Plain Node/Worker handoff: no runtime RPC stubs or predecessor fixture types. */
export interface DecisionClientPort {
  role: { endpoint: string; token: string; agentId: string; conversationId: string };
  firstJob: { jobId: string; approvalId: string };
  assertRejectedAndSettledWithoutStart(): Promise<void>;
}
export const releaseSet = (
  mode: Mode,
  deployments: readonly DeploymentIdentity[] = [],
): readonly string[] => {
  if (mode === "live") {
    // Only the validated actual target may determine applicability. An absent
    // identity stays fail-closed; no fixture/CLI switch can shrink the set.
    for (const deployment of deployments) assertDeployment(deployment);
    return liveClaims.filter(
      (id) =>
        id !== "real-cloud-tools" ||
        deployments.length === 0 ||
        deployments.some((deployment) => deployment.backend !== "free"),
    );
  }
  return mode === "local"
    ? [
        ...integratedClaims,
        "models-security",
        "public-clients",
        "installed-browser",
        "installed-tui-pty",
        "independent-python",
        "measurement-sensitivity",
      ]
    : ["portable-daemon"];
};
/** A partial set of passing rows cannot authorize the final provider action.
 * The two recovery-derived rows are produced only after this boundary. */
export function liveRecoveryReady(
  rows: readonly Pick<ClaimResult, "id" | "outcome">[],
  deployments: readonly DeploymentIdentity[],
): boolean {
  if (!deployments.length) return false;
  const excluded = new Set(["platform-recovery", "pi-lifecycle"]);
  const required = releaseSet("live", deployments).filter((id) => !excluded.has(id));
  const observed = new Map(rows.map((row) => [row.id, row.outcome]));
  return (
    observed.size === rows.length &&
    required.every((id) => observed.get(id) === "pass") &&
    rows.filter((row) => !excluded.has(row.id)).every((row) => row.outcome === "pass")
  );
}
/** Fixed nonsecret data transport, never artifact/job authority. Read once
 * after actual current-target validation; the parent owns source/API/ZIP auth. */
export async function readDeviceEvidenceData(
  path: string,
  out: string,
  current: DeploymentIdentity,
): Promise<DeviceEvidenceData> {
  assertDeployment(current);
  assert.ok(
    isAbsolute(path) && resolve(path) === path,
    "Device receipt must be an absolute canonical path",
  );
  assert.equal(await realpath(path), path);
  const output = resolve(out);
  assert.equal(await realpath(output), output);
  assert.ok(
    path !== output && !path.startsWith(`${output}${sep}`),
    "Device receipt must remain outside child output",
  );
  const before = await lstat(path);
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      (before.mode & 0o777) === 0o600,
  );
  if (process.getuid) assert.equal(before.uid, process.getuid());
  assert.ok(
    before.size > 0 && before.size <= 1048576,
    "Device receipt exceeds bounded metadata size",
  );
  const handle = await open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = await handle.stat();
    assert.equal(opened.dev, before.dev);
    assert.equal(opened.ino, before.ino);
    assert.equal(opened.nlink, 1);
    assert.equal(opened.mode & 0o777, 0o600);
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    assert.equal(length, before.size);
    const after = await handle.stat();
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.nlink, 1);
    assert.equal(after.mode & 0o777, 0o600);
    const data: DeviceEvidenceData = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, length)),
    );
    assertDeployment(data.initial.deployment);
    assertDeviceEvidenceData(data, current);
    return data;
  } finally {
    await handle.close();
  }
}
export async function evidenceProducer(
  input: EvidenceInput,
  candidate: CandidateManifest,
): Promise<Producer> {
  const root = resolve(import.meta.dirname, "../..");
  const trusted =
    candidate.publishable || input.mode !== "local" || process.env.GITHUB_ACTIONS === "true";
  const encoded = process.env.FORTIPI_EVIDENCE_PRODUCER;
  if (!encoded) {
    assert.ok(
      !trusted && candidate.scope === "fortipi-ci-test",
      "Actual evidence producer required",
    );
    return {
      workflowPath: ".github/workflows/ci.yml",
      workflowSha256: sha256(await regularBytes(resolve(root, ".github/workflows/ci.yml"))),
      workflowId: 0,
      runId: 0,
      runAttempt: 0,
    };
  }
  const value: unknown = JSON.parse(encoded);
  assertProducer(value, trusted);
  const expectedWorkflow =
    input.mode === "local" ? "ci.yml" : input.mode === "native" ? "release.yml" : "deploy.yml";
  assert.equal(
    value.workflowPath,
    `.github/workflows/${expectedWorkflow}`,
    "Evidence kind must use its actual approved workflow",
  );
  assert.equal(
    value.workflowSha256,
    sha256(await regularBytes(resolve(root, value.workflowPath))),
    "Evidence workflow bytes changed",
  );
  if (trusted) {
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
    assert.equal(process.env.GITHUB_REPOSITORY_ID, "1453249080");
    assert.equal(process.env.GITHUB_SHA, candidate.sourceCommit);
    assert.equal(Number(process.env.GITHUB_RUN_ID), value.runId);
    assert.equal(Number(process.env.GITHUB_RUN_ATTEMPT), value.runAttempt);
    assert.ok(process.env.GITHUB_WORKFLOW_REF?.startsWith(`${REPOSITORY}/${value.workflowPath}@`));
    assert.equal(
      process.env.GITHUB_JOB,
      input.mode === "local"
        ? "policy-and-integration"
        : input.mode === "native"
          ? "native"
          : "operate",
      "Actual evidence job identity required",
    );
  } else {
    assert.equal(candidate.publishable, false);
    assert.equal(candidate.scope, "fortipi-ci-test");
    assert.equal(value.workflowId, 0);
    assert.equal(value.runId, 0);
    assert.equal(value.runAttempt, 0);
  }
  return value;
}
/** Failure rows are retained. A partial set can never produce a passing gate. */
export async function writeEvidence(
  input: EvidenceInput,
  candidate: CandidateManifest,
  identity: Identity,
  results: ClaimResult[],
): Promise<boolean> {
  const ids = new Set<string>();
  await mkdir(resolve(input.out, "claims"), { recursive: true, mode: 0o700 });
  for (const row of results) {
    assert.match(row.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(row.id), "Duplicate evidence claim");
    ids.add(row.id);
    assert.deepEqual(row.identity, identity);
    await saveJson(resolve(input.out, "claims", `${row.id}.json`), row);
  }
  await saveJson(resolve(input.out, "results.json"), results);
  await writeFile(
    resolve(input.out, "v0.1.0-claims.md"),
    "| Claim | Source / candidate / assets | Environment | Command + seed | Observation | Oracle | Sensitivity | Limits / status |\n|---|---|---|---|---|---|---|---|\n" +
      results
        .map((r) =>
          [
            r.id,
            `${identity.sourceCommit} / ${identity.candidateSha256} / ${identity.assetManifestSha256}`,
            `${identity.platform}/${identity.architecture} Node${identity.node}`,
            `${r.command.join(" ")} seed1010`,
            JSON.stringify(r.observation),
            r.oracle,
            r.sensitivity.join("; "),
            `${r.outcome}: ${r.limitations.join("; ")}`,
          ]
            .map((s) => String(s).replaceAll("|", "\\|").replaceAll("\n", " "))
            .join(" | "),
        )
        .map((r) => `| ${r} |`)
        .join("\n") +
      "\n",
    { flag: "wx", mode: 0o600 },
  );
  if (
    releaseSet(input.mode, identity.deployments).some((id) => !ids.has(id)) ||
    results.length === 0 ||
    results.some((row) => row.outcome !== "pass")
  )
    return false;
  const files = await inventory(input.out);
  const gate: GateReceipt = {
    schemaVersion: 1,
    kind: input.mode === "local" ? "integrated" : input.mode,
    candidateSha256: identity.candidateSha256,
    sourceCommit: identity.sourceCommit,
    scope: candidate.scope,
    producer: identity.producer,
    checkedAt: new Date().toISOString(),
    claims: results.map((r) => {
      const result = files.find((f) => f.path === `claims/${r.id}.json`);
      assert.ok(result);
      return { id: r.id, outcome: "pass", result };
    }),
    platforms: input.mode === "native" ? [process.platform as "linux" | "darwin" | "win32"] : [],
    deployments: identity.deployments,
    files,
  };
  await saveJson(resolve(input.out, "gate.json"), gate);
  return true;
}
