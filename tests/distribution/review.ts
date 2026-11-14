import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { imageInputs } from "../../apps/worker/container/inputs.ts";
import { verifySourceKit } from "../../scripts/image-source-distribution.ts";
import { type CandidateReadContext, loadCandidate } from "../../scripts/prepare-release.ts";
import {
  freshness,
  object,
  readJson,
  regularBytes,
  sha256,
  string,
} from "../../scripts/verify-release-gates.ts";
import {
  compatibilityDetail,
  validateReleaseReport,
} from "../../tools/compatibility-watch/release.ts";

const root = resolve(import.meta.dirname, "../..");
/** Reauthenticate retained candidate facts against its actual source policies.
 * This consumes the normal producer's fresh review, never manufactures one. */
export async function supplyReview(path: string, context?: CandidateReadContext) {
  const { candidate } = await loadCandidate(path, context),
    directory = dirname(resolve(path));
  const review = object(await readJson(resolve(directory, "supply-chain/advisory-review.json")));
  assert.equal(object(review.locks)["pnpm-lock.yaml"], candidate.hashes.lock);
  assert.equal(
    object(review.locks)["tools/unstale/pnpm-lock.yaml"],
    sha256(await regularBytes(resolve(root, "tools/unstale/pnpm-lock.yaml"))),
  );
  assert.equal(review.reviewSha256, candidate.hashes.toolchainPolicy);
  const advisory = object(review.advisory);
  freshness(string(advisory.checkedAt), 24);
  assert.deepEqual(
    advisory.findings,
    [],
    "Unresolved recorded advisories cannot become an evidence pass",
  );
  const policy = object(await readJson(resolve(root, "tools/unstale/supply-chain.json")));
  assert.equal(
    sha256(await regularBytes(resolve(root, "tools/unstale/supply-chain.json"))),
    candidate.hashes.toolchainPolicy,
  );
  const licenses = object(await readJson(resolve(root, "tools/unstale/license-policy.json")));
  const inventory = object(await readJson(resolve(directory, "supply-chain/inventory.json")));
  assert.ok(Array.isArray(inventory.packages) && inventory.packages.length > 0);
  const identities = new Set<string>();
  for (const raw of inventory.packages) {
    const item = object(raw),
      id = string(item.id);
    assert.ok(!identities.has(id));
    identities.add(id);
    const fact = object(object(policy.packages)[id]);
    for (const field of ["integrity", "archiveSha256", "manifestSha256", "license"])
      assert.equal(
        item[field],
        fact[field],
        "Retained package facts differ from the exact source review",
      );
    assert.deepEqual(item.licenses, fact.licenses);
    assert.deepEqual(item.attribution, object(licenses.attributions)[id] ?? null);
    assert.deepEqual(item.obligations, object(licenses.exceptions)[id] ?? null);
    assert.ok(string(fact.signature));
  }
  return {
    retainedReviewedIdentities: identities.size,
    exactArchiveManifestLicenseFacts: true,
    exactAttributionsAndExceptions: true,
    bothLockHashesBound: true,
    advisoryCheckedAt: advisory.checkedAt,
    unresolvedRecordedFindings: 0,
    limitations: [
      "Recorded exact-graph review plus fresh consumer SRI; no blanket future-advisory clearance",
      "Publication Sigstore/registry identity is a separate privileged release gate",
    ],
  };
}
export async function compatibilityReview(path: string, context?: CandidateReadContext) {
  const { candidate, hash } = await loadCandidate(path, context);
  const bytes = await regularBytes(
    resolve(dirname(resolve(path)), "compatibility.json"),
    1_000_000,
  );
  const imageMetadata = await regularBytes(
    resolve(dirname(resolve(path)), "image/image-metadata.json"),
    8_000_000,
  );
  assert.equal(sha256(imageMetadata), candidate.image.metadataSha256);
  const advisoryReview = await regularBytes(
    resolve(dirname(resolve(path)), "supply-chain/advisory-review.json"),
    1_000_000,
  );
  const report = await validateReleaseReport(
    root,
    JSON.parse(bytes.toString()),
    candidate.sourceCommit,
    Date.now(),
    { imageMetadata, advisoryReview },
  );
  assert.equal(candidate.hashes.toolchainPolicy, report.validationInputs.sourcePolicySha256);
  assert.equal(candidate.hashes.lock, sha256(await regularBytes(resolve(root, "pnpm-lock.yaml"))));
  const image = object(
    object(await readJson(resolve(root, "tools/compatibility-watch/baseline.json")))
      .releaseReference,
  ).cohort;
  for (const key of ["sourceCommit", "metadataSha256", "builtManifestDigest", "sourceKitSha256"])
    assert.equal(
      candidate.image[key as keyof typeof candidate.image],
      object(object(image).image)[key],
    );
  return compatibilityDetail(report, bytes, hash);
}
export async function imageSourceReview(path: string, context?: CandidateReadContext) {
  const { candidate } = await loadCandidate(path, context),
    directory = dirname(resolve(path));
  const metadata = object(await readJson(resolve(directory, "image/image-metadata.json")));
  assert.equal(
    sha256(await regularBytes(resolve(directory, "image/image-metadata.json"))),
    candidate.image.metadataSha256,
  );
  assert.equal(metadata.computerSource, imageInputs.source);
  assert.equal(metadata.computerVersion, imageInputs.computerVersion);
  assert.equal(metadata.embeddedNodeVersion, imageInputs.embeddedNodeVersion);
  assert.equal(metadata.imageId, candidate.image.imageId);
  assert.equal(metadata.builtManifestDigest, candidate.image.builtManifestDigest);
  assert.equal(metadata.sourceCommit, candidate.image.sourceCommit);
  const extracted = await mkdtemp(resolve(tmpdir(), "fortipi-evidence-source-kit-"));
  try {
    const kit = await verifySourceKit(
      {
        kit: resolve(directory, "image/sources-and-notices.tar"),
        kitSha256: candidate.image.sourceKitSha256,
        commit: candidate.image.sourceCommit,
        repository: root,
      },
      extracted,
    );
    return {
      exactSourceKitAndSignatures: true,
      imageSourceCommit: kit.sourceCommit,
      sourceKitSha256: kit.sourceKitSha256,
      imageId: candidate.image.imageId,
      builtManifestDigest: candidate.image.builtManifestDigest,
      actualNodeSeaBlobSha256: kit.seaBlobSha256,
      limitations: [
        "Independent source/legal/authenticated-input verification of the exact retained image identity",
        "Linux native/FUSE/network/relink runtime proof is the separately authenticated image workflow; no new runtime claim here",
      ],
    };
  } finally {
    await rm(extracted, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
