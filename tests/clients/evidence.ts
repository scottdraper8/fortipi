import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
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

export type Mode = "local" | "native" | "live";
export interface EvidenceInput {
  mode: Mode;
  candidateManifest: string;
  deploymentReceipt?: string;
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
export const releaseSet = (mode: Mode): readonly string[] =>
  mode === "local"
    ? [
        ...integratedClaims,
        "models-security",
        "public-clients",
        "installed-browser",
        "installed-tui-pty",
        "independent-python",
        "measurement-sensitivity",
      ]
    : mode === "live"
      ? liveClaims
      : ["portable-daemon"];
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
    releaseSet(input.mode).some((id) => !ids.has(id)) ||
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
