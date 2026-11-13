import assert from "node:assert/strict";
import { isAbsolute, resolve, sep } from "node:path";
import { validateApplicationRecoveryCheckpoints } from "./application-recovery-checkpoints.ts";
import type { ApplicationRecoveryProof } from "./application-recovery-coordinator.ts";
import type { ProviderTransition } from "./platform-recovery.ts";
import {
  assertDeployment,
  assertGate,
  type CandidateManifest,
  canonicalJson,
  type DeploymentIdentity,
  type GateReceipt,
  type GitHubRequest,
  object,
  readProofBundle,
  regularBytes,
  sha256,
  verifyPayload,
  verifyProducer,
} from "./verify-release-gates.ts";

const stable = ({ checkedAt: _time, ...value }: DeploymentIdentity) => value;
const closed = (value: object, keys: string[]) =>
  assert.deepEqual(Object.keys(value).sort(), keys.toSorted());
async function canonicalFile(path: string, limit = 1_048_576) {
  const bytes = await regularBytes(path, limit);
  const value = object(JSON.parse(bytes.toString("utf8")));
  assert.equal(bytes.toString("utf8"), `${canonicalJson(value)}\n`);
  return { bytes, value };
}

/** Validate actual inventoried application checkpoints and provider history.
 * The sidecar correlates these bytes; its serialized fields grant no authority. */
export async function validateRecoveryRetention(input: {
  candidate: CandidateManifest;
  candidateSha256: string;
  kind: "live" | "independent";
  child: GateReceipt;
  claimsDirectory: string;
  deployment: DeploymentIdentity;
  originalCliPath: string;
  currentReceiptPath: string;
  factsPath: string;
  proofsPath: string;
  request: GitHubRequest;
}): Promise<void> {
  assertGate(input.child);
  assert.equal(input.child.kind, "live");
  assert.equal(input.child.candidateSha256, input.candidateSha256);
  assert.equal(input.child.sourceCommit, input.candidate.sourceCommit);
  assert.equal(input.child.scope, input.candidate.scope);
  assertDeployment(input.deployment);
  const directory = resolve(input.claimsDirectory);
  assert.ok(isAbsolute(input.factsPath));
  assert.ok(input.factsPath !== directory && !input.factsPath.startsWith(`${directory}${sep}`));
  const facts = (await canonicalFile(input.factsPath)).value;
  assert.ok(facts.mode === "perform" || facts.mode === "verify-existing");
  assert.equal(facts.mode, input.kind === "live" ? "perform" : "verify-existing");
  closed(facts, [
    "schemaVersion",
    "sourceCommit",
    "candidateSha256",
    "original",
    "childStartupObservation",
    "current",
    "childGateSha256",
    "originalDeploymentSha256",
    "originalCliSha256",
    "currentReceiptSha256",
    "receiptProvenance",
    "mode",
    "operationId",
    "transitionSha256",
    "proofSha256",
    "before",
    "after",
    "transitionBefore",
    "transitionAfter",
    ...(facts.mode === "verify-existing" ? ["evidence"] : []),
  ]);
  assert.equal(facts.schemaVersion, 1);
  assert.equal(facts.sourceCommit, input.candidate.sourceCommit);
  assert.equal(facts.candidateSha256, input.candidateSha256);
  assert.equal(facts.receiptProvenance, "provider-confirmed-version; not a second CLI invocation");
  assert.equal(facts.childGateSha256, sha256(await regularBytes(resolve(directory, "gate.json"))));
  assertDeployment(facts.original);
  assertDeployment(facts.childStartupObservation);
  assertDeployment(facts.current);
  for (const value of [facts.original, facts.childStartupObservation, facts.current]) {
    assertDeployment(value);
    assert.equal(value.sourceCommit, input.candidate.sourceCommit);
    assert.equal(value.candidateSha256, input.candidateSha256);
  }
  assert.deepEqual(input.child.deployments, [facts.childStartupObservation]);
  assert.deepEqual(stable(facts.current), stable(input.deployment));
  const originals = resolve(directory, "provider-recovery");
  const original = await canonicalFile(resolve(originals, "original-deployment.json"));
  assert.equal(sha256(original.bytes), facts.originalDeploymentSha256);
  assert.deepEqual(original.value, facts.original);
  const cli = await canonicalFile(input.originalCliPath);
  assert.equal(sha256(cli.bytes), facts.originalCliSha256);
  assert.deepEqual(
    await regularBytes(resolve(originals, "original-deployment.cli.json")),
    cli.bytes,
  );
  const receipt = await canonicalFile(input.currentReceiptPath);
  assert.equal(sha256(receipt.bytes), facts.currentReceiptSha256);
  assert.deepEqual(receipt.value, {
    ...cli.value,
    workerVersionId: input.deployment.workerVersionId,
  });

  let root = directory;
  let prefix = "";
  if (facts.mode === "verify-existing") {
    const bundle = await readProofBundle(input.proofsPath);
    const matches = bundle.proofs.filter(
      ({ artifact }) => canonicalJson(artifact) === canonicalJson(facts.evidence),
    );
    assert.equal(matches.length, 1);
    const proof = matches[0];
    assert.ok(proof);
    assert.equal(proof.receipt.kind, "live");
    assert.equal(proof.receipt.candidateSha256, input.candidateSha256);
    assert.equal(proof.receipt.sourceCommit, input.candidate.sourceCommit);
    assert.equal(proof.receipt.scope, input.candidate.scope);
    assert.ok(proof.receipt.claims.every((claim) => claim.outcome === "pass"));
    assert.equal(proof.receipt.deployments.length, 1);
    const deployment = proof.receipt.deployments[0];
    assert.ok(deployment);
    assert.deepEqual(stable(deployment), stable(input.deployment));
    const gate = await canonicalFile(resolve(proof.directory, "gate.json"), 8_000_000);
    assert.deepEqual(gate.value, proof.receipt);
    await verifyProducer(
      input.candidate,
      "live",
      proof.receipt.producer,
      proof.artifact,
      input.request,
      Date.now(),
      sha256(gate.bytes),
    );
    await verifyPayload(proof.directory, proof.receipt.files, ["gate.json"]);
    root = proof.directory;
    prefix = "claims/";
    assert.deepEqual(stable(facts.childStartupObservation), stable(input.deployment));
  } else {
    assert.deepEqual(facts.childStartupObservation, facts.original);
  }
  const proofFile = await canonicalFile(
    resolve(root, `${prefix}provider-recovery/application-recovery.json`),
  );
  assert.equal(sha256(proofFile.bytes), facts.proofSha256);
  const proof = proofFile.value as unknown as ApplicationRecoveryProof;
  closed(proof, [
    "schemaVersion",
    "sourceCommit",
    "candidateSha256",
    "operationId",
    "transitionSha256",
    "before",
    "after",
  ]);
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.sourceCommit, input.candidate.sourceCommit);
  assert.equal(proof.candidateSha256, input.candidateSha256);
  assert.equal(proof.operationId, facts.operationId);
  assert.equal(proof.transitionSha256, facts.transitionSha256);
  assert.deepEqual(proof.before, facts.before);
  assert.deepEqual(proof.after, facts.after);
  assert.equal(proof.before.path, "application-recovery/application-before.json");
  assert.equal(proof.after.path, "application-recovery/application-after.json");
  const transitionFile = await canonicalFile(
    resolve(root, `${prefix}provider-recovery/transition.json`),
  );
  assert.equal(sha256(transitionFile.bytes), proof.transitionSha256);
  const transition = transitionFile.value as unknown as ProviderTransition;
  assert.equal(transition.operationId, proof.operationId);
  assert.deepEqual(transition.before, facts.transitionBefore);
  assert.deepEqual(transition.after, facts.transitionAfter);
  if (facts.mode === "perform") assert.deepEqual(transition.before, facts.original);
  const intent = await regularBytes(
    resolve(root, `${prefix}provider-recovery/intent.json`),
    1_048_576,
  );
  assert.equal(sha256(intent), transition.intentSha256);
  await validateApplicationRecoveryCheckpoints({
    checkpointDirectory: resolve(directory, "application-recovery"),
    candidateSha256: input.candidateSha256,
    sourceCommit: input.candidate.sourceCommit,
    before: { ...proof.before, path: resolve(directory, proof.before.path) },
    after: { ...proof.after, path: resolve(directory, proof.after.path) },
    provider: { transition, transitionSha256: proof.transitionSha256, current: input.deployment },
  });
  const rows = input.child.claims.filter(
    (claim) => claim.id === "platform-recovery" && claim.outcome === "pass",
  );
  assert.equal(rows.length, 1);
  const claim = rows[0];
  assert.ok(claim);
  const row = (await canonicalFile(resolve(directory, claim.result.path))).value;
  assert.equal(row.id, "platform-recovery");
  assert.equal(row.outcome, "pass");
  assert.deepEqual(object(row.identity).deployments, input.child.deployments);
  const observation = object(row.observation);
  assert.equal(observation.mode, facts.mode);
  const operation = object(observation.operation);
  assert.equal(operation.status, "operation-confirmed");
  assert.equal(operation.operationEvidenceSha256, proof.transitionSha256);
  assert.deepEqual(operation.before, transition.before);
  assert.deepEqual(operation.after, transition.after);
}
