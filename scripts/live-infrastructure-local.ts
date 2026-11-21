import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  assertCandidate,
  type CandidateManifest,
  canonicalJson,
  digest,
  freshness,
  type GitHubRequest,
  integratedClaims,
  object,
  readProofBundle,
  regularBytes,
  sha256,
  verifyPayload,
  verifyProducer,
} from "./verify-release-gates.ts";

/** Trusted parent read port. The caller already authenticated the candidate and
 * bound proofsPath; this authenticates its completed integrated predecessor.
 * Returned original JSON is DATA. Detailed scenario semantics belong to the
 * consumer, and neither receipt labels nor local hashes grant authority. */
export async function readLocalInfrastructureProof(input: {
  candidate: CandidateManifest;
  candidateSha256: string;
  proofsPath: string;
  request: GitHubRequest;
  now?: number;
}) {
  const candidate = structuredClone(input.candidate);
  const { candidateSha256, proofsPath, request, now = Date.now() } = input;
  assertCandidate(candidate);
  digest(candidateSha256);
  assert.equal(
    sha256(`${canonicalJson(candidate)}\n`),
    candidateSha256,
    "Candidate identity mismatch",
  );
  const bundle = await readProofBundle(proofsPath);
  assert.equal(bundle.candidateArtifact.candidateSha256, candidateSha256);
  const matches = bundle.proofs.filter((proof) => proof.receipt.kind === "integrated");
  assert.equal(matches.length, 1, "Exactly one integrated predecessor required");
  const proof = matches[0];
  assert.ok(proof);
  const gate = proof.receipt;
  assert.equal(gate.candidateSha256, candidateSha256);
  assert.equal(proof.artifact.candidateSha256, candidateSha256);
  assert.equal(gate.sourceCommit, candidate.sourceCommit);
  assert.equal(gate.scope, candidate.scope);
  assert.deepEqual(gate.platforms, []);
  assert.deepEqual(gate.deployments, []);
  freshness(gate.checkedAt, 24, now);
  for (const id of integratedClaims)
    assert.ok(
      gate.claims.some((claim) => claim.id === id && claim.outcome === "pass"),
      "Partial integrated predecessor",
    );
  const claim = gate.claims.find((row) => row.id === "infrastructure-boundaries");
  assert.ok(
    claim && claim.result.path === "claims/infrastructure-boundaries.json",
    "Infrastructure claim required",
  );
  const gateBytes = await regularBytes(resolve(proof.directory, "gate.json"), 750000);
  assert.ok(
    gateBytes.equals(Buffer.from(`${canonicalJson(gate)}\n`)),
    "Canonical original gate JSON required",
  );
  assert.ok(
    claim.result.size <= 750000 - gateBytes.length,
    "Combined infrastructure JSON byte bound",
  );
  const reference = structuredClone(proof.artifact);
  assert.deepEqual(
    Object.keys(reference).sort(),
    [
      "runId",
      "runAttempt",
      "artifactId",
      "artifactName",
      "artifactDigest",
      "candidateSha256",
    ].sort(),
  );
  // Authenticate actual archive gate bytes BEFORE walking/reading result payloads.
  await verifyProducer(
    candidate,
    "integrated",
    gate.producer,
    reference,
    request,
    now,
    sha256(gateBytes),
  );
  await verifyPayload(proof.directory, gate.files, ["gate.json"]);
  const resultBytes = await regularBytes(
    resolve(proof.directory, claim.result.path),
    750000 - gateBytes.length,
  );
  assert.equal(resultBytes.length, claim.result.size);
  assert.equal(sha256(resultBytes), claim.result.sha256, "Infrastructure result changed");
  const resultJson = resultBytes.toString("utf8"),
    result = object(JSON.parse(resultJson));
  assert.ok(
    resultBytes.equals(Buffer.from(`${canonicalJson(result)}\n`)),
    "Canonical original result JSON required",
  );
  assert.equal(result.id, "infrastructure-boundaries");
  assert.equal(result.outcome, "pass");
  return { reference, gateJson: gateBytes.toString("utf8"), resultJson };
}
