import assert from "node:assert/strict";
import { basename, dirname, resolve } from "node:path";
import { repository } from "./build-workspaces.ts";
import {
  childEnvironment,
  execute,
  loadCandidate,
  type PublicationJournal,
  verifyProvenance,
} from "./prepare-release.ts";
import {
  cliArgs,
  freshness,
  type GitHubRequest,
  githubRequest,
  integer,
  inventory,
  object,
  privilegedCheckout,
  REPOSITORY,
  readJson,
  readProofBundle,
  records,
  regularBytes,
  remoteHash,
  saveJson,
  sha256,
  string,
  trustedMain,
  verifyCurrentReadinessSet,
  verifyPayload,
} from "./verify-release-gates.ts";
export function releaseChecksums(files: { name: string; sha256: string }[]): Buffer {
  return Buffer.from(
    `${[...files]
      .sort((a, b) => a.name.localeCompare(b.name, "en"))
      .map((file) => `${file.sha256}  ${file.name}`)
      .join("\n")}\n`,
  );
}

/** Reconcile existing tags/releases/assets; never move a tag or overwrite an asset. */
export async function collectReleaseAssets(
  candidatePath: string,
  proofsPath: string,
  journalPath: string,
  confirmation: string,
  readinessDirectory: string,
  request: GitHubRequest = githubRequest(process.env.GITHUB_TOKEN),
  transport: typeof fetch = fetch,
): Promise<void> {
  const { candidate, hash, directory } = await loadCandidate(candidatePath);
  assert.equal(
    confirmation,
    `finalize ${candidate.tag} ${candidate.sourceCommit} ${candidate.scope}`,
  );
  await privilegedCheckout(candidate);
  await trustedMain(candidate, request);
  const gate = await execute(
    process.execPath,
    [
      "scripts/verify-release-gates.ts",
      "verify",
      "--candidate",
      candidatePath,
      "--proofs",
      proofsPath,
      "--readiness",
      readinessDirectory,
      "--phase",
      "final-readiness",
    ],
    repository,
    childEnvironment({ GITHUB_TOKEN: process.env.GITHUB_TOKEN }),
    300000,
  );
  assert.equal(gate.code, 0, "Required release gates unavailable");
  const journal = (await readJson(journalPath)) as PublicationJournal;
  assert.equal(journal.candidateSha256, hash);
  assert.equal(journal.packages.length, 5);
  for (const pkg of candidate.packages)
    assert.ok(
      journal.packages.some(
        (p) =>
          p.name === pkg.name &&
          p.version === pkg.version &&
          p.sha256 === pkg.sha256 &&
          p.state === "available",
      ),
      "Partial publication cannot finalize",
    );
  const provenance = object(await readJson(resolve(dirname(journalPath), "provenance.json")));
  assert.equal(provenance.candidateSha256, hash);
  assert.equal(provenance.sourceCommit, candidate.sourceCommit);
  freshness(string(provenance.checkedAt), 0.25);
  const bundles = await regularBytes(resolve(dirname(journalPath), "verified-bundles.json"));
  assert.equal(sha256(bundles), provenance.bundlesSha256);
  const savedBundles = object(JSON.parse(bundles.toString("utf8")));
  assert.equal(savedBundles.candidateSha256, hash);
  assert.deepEqual(
    verifyProvenance({ verified: savedBundles.packages }, candidate),
    provenance.verifiedPackages,
  );
  const runId = integer(Number(process.env.GITHUB_RUN_ID));
  const runAttempt = integer(Number(process.env.GITHUB_RUN_ATTEMPT));
  assert.equal(provenance.publicationRunId, runId);
  assert.equal(provenance.publicationRunAttempt, runAttempt);
  const artifacts = object(
    await request(`/repos/${REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100&page=1`),
  );
  assert.ok(Array.isArray(artifacts.artifacts) && Number(artifacts.total_count) <= 100);
  const publication = artifacts.artifacts
    .map(object)
    .filter(
      (a) =>
        a.name ===
        `publication-${candidate.sourceCommit}-${candidate.scope}-${runId}-${runAttempt}`,
    );
  assert.equal(publication.length, 1);
  const published = publication[0];
  assert.ok(published);
  assert.equal(published.expired, false);
  assert.equal(object(published.workflow_run).id, runId);
  assert.equal(object(published.workflow_run).head_sha, candidate.sourceCommit);
  const jobs = object(
    await request(
      `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=1`,
    ),
  );
  assert.ok(Array.isArray(jobs.jobs) && Number(jobs.total_count) <= 100);
  const publisher = jobs.jobs.map(object).filter((j) => j.name === "publish");
  assert.equal(publisher.length, 1);
  assert.equal(publisher[0]?.conclusion, "success");
  assert.equal(publisher[0]?.status, "completed");
  assert.ok(
    Date.parse(string(published.created_at)) >= Date.parse(string(publisher[0]?.started_at)) &&
      Date.parse(string(published.created_at)) <= Date.parse(string(publisher[0]?.completed_at)),
  );
  for (const name of [
    "journal.json",
    "provenance.json",
    "verified-bundles.json",
    "registry-evidence-inventory.json",
  ]) {
    const original = await request.verifyArtifact(
      {
        runId,
        runAttempt,
        artifactId: integer(published.id),
        artifactName: string(published.name),
        artifactDigest: string(published.digest),
        candidateSha256: hash,
      },
      name,
    );
    assert.ok(original);
    assert.equal(
      sha256(original),
      sha256(await regularBytes(resolve(dirname(journalPath), name))),
      "Publication result differs from completed publisher",
    );
  }
  const { candidateArtifact, proofs } = await readProofBundle(proofsPath);
  const registryInventory = object(
    await readJson(resolve(dirname(journalPath), "registry-evidence-inventory.json")),
  );
  assert.equal(registryInventory.candidateSha256, hash);
  records(registryInventory.files);
  await verifyPayload(resolve(dirname(journalPath), "registry-evidence"), registryInventory.files);
  const outputs = [
    ...candidate.files.map((f) => ({
      name: f.path.replaceAll("/", "__"),
      bytes: () => regularBytes(resolve(directory, f.path)),
      sha256: f.sha256,
    })),
    { name: "candidate.json", bytes: () => regularBytes(candidatePath), sha256: hash },
    ...(await Promise.all(
      ["provenance.json", "verified-bundles.json", basename(journalPath)].map(async (name) => {
        const path = resolve(dirname(journalPath), name);
        const bytes = await regularBytes(path);
        return { name, bytes: async () => bytes, sha256: sha256(bytes) };
      }),
    )),
    {
      name: "evidence-producers.json",
      bytes: async () =>
        Buffer.from(
          `${JSON.stringify({ candidateArtifact, proofs: proofs.map((p) => ({ artifact: p.artifact, receipt: p.receipt })) })}\n`,
        ),
      sha256: "",
    },
  ];
  const producers = outputs.at(-1);
  assert.ok(producers);
  producers.sha256 = sha256(await producers.bytes());
  for (const [index, proof] of proofs.entries())
    for (const file of [
      {
        path: "gate.json",
        sha256: sha256(await regularBytes(resolve(proof.directory, "gate.json"))),
      },
      ...proof.receipt.files,
    ])
      outputs.push({
        name: `evidence-${index}__${file.path.replaceAll("/", "__")}`,
        bytes: () => regularBytes(resolve(proof.directory, file.path)),
        sha256: file.sha256,
      });
  for (const file of await inventory(resolve(dirname(journalPath), "registry-evidence")))
    outputs.push({
      name: `registry-evidence__${file.path.replaceAll("/", "__")}`,
      bytes: () => regularBytes(resolve(dirname(journalPath), "registry-evidence", file.path)),
      sha256: file.sha256,
    });
  const checksumBytes = releaseChecksums(outputs);
  outputs.push({
    name: "SHA256SUMS",
    bytes: async () => checksumBytes,
    sha256: sha256(checksumBytes),
  });
  assert.equal(
    new Set(outputs.map((f) => f.name)).size,
    outputs.length,
    "Release filename collision",
  );
  const base = `/repos/${REPOSITORY}`;
  const refs = await request(`${base}/git/matching-refs/tags/${candidate.tag}`);
  assert.ok(Array.isArray(refs));
  await verifyCurrentReadinessSet(
    candidate,
    hash,
    proofs,
    { directory: readinessDirectory, phase: "final-readiness" },
    request,
  );
  if (!refs.some((r) => object(r).ref === `refs/tags/${candidate.tag}`))
    await request(`${base}/git/refs`, "POST", {
      ref: `refs/tags/${candidate.tag}`,
      sha: candidate.sourceCommit,
    });
  await trustedMain(candidate, request);
  const releases: Record<string, unknown>[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = await request(`${base}/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(response));
    releases.push(...response.map(object));
    if (response.length < 100) break;
    assert.ok(page < 20, "Release pagination bound");
  }
  let release = releases.find((r) => r.tag_name === candidate.tag);
  if (!release)
    release = object(
      await request(`${base}/releases`, "POST", {
        tag_name: candidate.tag,
        target_commitish: candidate.sourceCommit,
        name: candidate.tag,
        draft: true,
        generate_release_notes: false,
        body: `FortiPi ${candidate.version}; source ${candidate.sourceCommit}; immutable candidate SHA-256 ${hash}. See retained evidence and notices.`,
      }),
    );
  const id = integer(release.id);
  const assets: Record<string, unknown>[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = await request(`${base}/releases/${id}/assets?per_page=100&page=${page}`);
    assert.ok(Array.isArray(response));
    assets.push(...response.map(object));
    if (response.length < 100) break;
    assert.ok(page < 20, "Asset pagination bound");
  }
  const token = process.env.GITHUB_TOKEN;
  assert.ok(token, "Release write credential unavailable");
  for (const output of outputs) {
    const existing = assets.filter((asset) => asset.name === output.name);
    assert.ok(existing.length <= 1, "Ambiguous release asset");
    if (existing[0]) {
      const asset = existing[0];
      assert.equal(
        asset.digest,
        `sha256:${output.sha256}`,
        "Existing release asset differs; no overwrite",
      );
      assert.equal(
        await remoteHash(
          `https://api.github.com${base}/releases/assets/${integer(asset.id)}`,
          { Authorization: `Bearer ${token}`, Accept: "application/octet-stream" },
          transport,
        ),
        output.sha256,
      );
      continue;
    }
    assert.equal(
      release.draft,
      true,
      "Published release missing retained asset; manual reconciliation required",
    );
    const bytes = await output.bytes();
    assert.equal(sha256(bytes), output.sha256);
    const response: Response = await transport(
      `https://uploads.github.com${base}/releases/${id}/assets?name=${encodeURIComponent(output.name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(bytes),
        redirect: "error",
        signal: AbortSignal.timeout(120000),
      },
    );
    assert.ok(response.ok, `Release asset upload HTTP ${response.status}`);
    const saved = object(await response.json());
    assert.equal(saved.name, output.name);
    assert.equal(saved.digest, `sha256:${output.sha256}`);
    assert.equal(saved.size, bytes.length);
  }
  await trustedMain(candidate, request);
  // Recheck freshness and exact artifacts after potentially long asset uploads, before making a draft public.
  const finalGate = await execute(
    process.execPath,
    [
      "scripts/verify-release-gates.ts",
      "verify",
      "--candidate",
      candidatePath,
      "--proofs",
      proofsPath,
      "--readiness",
      readinessDirectory,
      "--phase",
      "final-readiness",
    ],
    repository,
    childEnvironment({ GITHUB_TOKEN: process.env.GITHUB_TOKEN }),
    300000,
  );
  assert.equal(finalGate.code, 0);
  if (release.draft === true) await request(`${base}/releases/${id}`, "PATCH", { draft: false });
  await saveJson(resolve(dirname(journalPath), "release.json"), {
    schemaVersion: 1,
    candidateSha256: hash,
    sourceCommit: candidate.sourceCommit,
    tag: candidate.tag,
    releaseId: id,
    assets: outputs.map((o) => ({ name: o.name, sha256: o.sha256 })),
    checkedAt: new Date().toISOString(),
  });
}
if (import.meta.main) {
  try {
    const a = cliArgs();
    assert.equal(process.argv[2], "finalize");
    await collectReleaseAssets(
      string(a.candidate),
      string(a.proofs),
      string(a.journal),
      string(a.confirm),
      string(a.readiness),
    );
  } catch {
    console.error(
      "Release finalization incomplete; retained tags/assets are not overwritten or rolled back.",
    );
    process.exitCode = 1;
  }
}
