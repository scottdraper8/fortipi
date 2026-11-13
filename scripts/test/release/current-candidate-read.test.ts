import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { repository } from "../../build-workspaces.ts";
import {
  resolveCurrentCandidateReference,
  verifyCurrentCandidateRead,
} from "../../current-candidate-read.ts";
import {
  type ArtifactReference,
  canonicalJson,
  git,
  githubRequest,
  REPOSITORY,
  REPOSITORY_ID,
  SYNTHETIC_SCOPE,
  sha256,
  trustedMain,
  verifyProducer,
} from "../../verify-release-gates.ts";
import { candidate, httpFixture, jsonArchive, metadataArchive } from "./fixtures.ts";

async function fixture(scope = "release-fixture", job = "native") {
  const c = candidate();
  c.sourceCommit = await git("rev-parse", "HEAD");
  assert.equal(
    await git("status", "--porcelain"),
    "",
    "Fixture needs actual committed clean source",
  );
  const workflow = (
    await promisify(execFile)("git", ["show", `${c.sourceCommit}:.github/workflows/release.yml`], {
      cwd: repository,
      encoding: "buffer",
      maxBuffer: 4_000_000,
    })
  ).stdout;
  c.scope = scope;
  c.publishable = scope !== SYNTHETIC_SCOPE;
  for (const pkg of c.packages) pkg.name = `@${scope}/${pkg.sourceName}`;
  c.producer = {
    workflowPath: ".github/workflows/release.yml",
    workflowSha256: sha256(workflow),
    workflowId: 11,
    runId: 80,
    runAttempt: 1,
  };
  const bytes = Buffer.from(`${canonicalJson(c)}\n`);
  const originalZip = await metadataArchive(c);
  const foreignZip = await metadataArchive({
    ...c,
    assetManifestSha256: sha256("different actual producer metadata"),
  });
  const missingZip = await jsonArchive(c, "candidate.json");
  const hash = sha256(bytes);
  let zip: { bytes: Buffer; close: () => Promise<void> } = originalZip;
  const now = Date.now();
  let fault = "";
  let downloaded = false;
  let downloads = 0;
  const urls: string[] = [];
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
    GITHUB_JOB: job,
    GITHUB_SHA: c.sourceCommit,
    SOURCE_SHA: c.sourceCommit,
    GITHUB_RUN_ID: "80",
    GITHUB_RUN_ATTEMPT: "1",
    OPERATION: "candidate",
    RELEASE_VERSION: c.version,
    RELEASE_SCOPE: c.scope,
    EXPECTED_TAG: c.tag,
    CONFIRM: `candidate v${c.version} ${c.sourceCommit} ${c.scope}`,
  };
  const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const ref: ArtifactReference = {
    runId: 80,
    runAttempt: 1,
    artifactId: 40,
    artifactName: `candidate-${c.sourceCommit}-${scope}-80-1`,
    artifactDigest: `sha256:${sha256(zip.bytes)}`,
    candidateSha256: hash,
  };
  const server = await httpFixture((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, undefined);
    const route = req.url ?? "";
    urls.push(route);
    if (route.endsWith("/zip")) {
      res.writeHead(302, { location: "https://fixture.blob.core.windows.net/candidate.zip" });
      res.end();
      return;
    }
    if (route === "/candidate.zip") {
      downloads++;
      downloaded = true;
      if (fault === "expires-after-zip") setTimeout(() => res.end(zip.bytes), 2200);
      else res.end(zip.bytes);
      return;
    }
    const artifact = {
      id: 40,
      name: ref.artifactName,
      digest: ref.artifactDigest,
      expired: fault === "expired",
      created_at: new Date(now - (fault === "wrong-window" ? 50_000 : 2000)).toISOString(),
      expires_at: new Date(
        fault === "expires-after-zip" ? Date.now() + 2000 : now + 60_000,
      ).toISOString(),
      workflow_run: {
        id: 80,
        repository_id: REPOSITORY_ID,
        head_repository_id: fault === "foreign-artifact" ? 1 : REPOSITORY_ID,
        head_branch: "main",
        head_sha: c.sourceCommit,
      },
    };
    const candidateJob = {
      id: 100,
      name: "candidate",
      run_id: 80,
      head_sha: c.sourceCommit,
      status: fault === "unfinished-candidate" ? "in_progress" : "completed",
      conclusion:
        fault === "skipped-candidate"
          ? "skipped"
          : fault === "failed-candidate"
            ? "failure"
            : "success",
      started_at: new Date(now - 10_000).toISOString(),
      completed_at: new Date(now - 1000).toISOString(),
    };
    let value: unknown;
    if (route === `/repos/${REPOSITORY}`) value = { id: REPOSITORY_ID, full_name: REPOSITORY };
    else if (route.endsWith("/git/ref/heads/main"))
      value = {
        object: {
          sha:
            fault === "main" || (fault === "main-after-zip" && downloaded)
              ? "f".repeat(40)
              : c.sourceCommit,
        },
      };
    else if (route.includes("matching-refs"))
      value =
        fault === "tag"
          ? [{ ref: `refs/tags/${c.tag}`, object: { type: "commit", sha: "f".repeat(40) } }]
          : [];
    else if (route.includes("/contents/"))
      value = {
        encoding: "base64",
        content: `${Buffer.from(fault === "workflow-bytes" ? "foreign workflow" : workflow)
          .toString("base64")
          .match(/.{1,60}/g)
          ?.join("\n")}\n`,
      };
    else if (route.endsWith("/actions/workflows/11"))
      value = { id: 11, path: ".github/workflows/release.yml", state: "active" };
    else if (route.includes("/jobs?"))
      value = {
        total_count: fault === "duplicate-candidate" ? 2 : 1,
        jobs:
          fault === "missing-candidate"
            ? [{ ...candidateJob, name: "unrelated" }]
            : fault === "duplicate-candidate"
              ? [candidateJob, { ...candidateJob, id: 101 }]
              : [candidateJob],
      };
    else if (route.includes("/artifacts?"))
      value = {
        total_count: fault === "duplicate-artifact" ? 2 : 1,
        artifacts:
          fault === "duplicate-artifact" ? [artifact, { ...artifact, id: 41 }] : [artifact],
      };
    else if (route.endsWith("/actions/artifacts/40")) value = artifact;
    else if (route.includes("/actions/runs/80"))
      value = {
        id: 80,
        run_attempt:
          fault === "superseded" || (fault === "superseded-after-zip" && downloaded) ? 2 : 1,
        workflow_id: 11,
        head_sha: c.sourceCommit,
        head_branch: "main",
        event: "workflow_dispatch",
        path: ".github/workflows/release.yml",
        repository: { id: REPOSITORY_ID },
        head_repository: { id: fault === "foreign-run" ? 1 : REPOSITORY_ID },
        status: "in_progress",
        conclusion: null,
      };
    else {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  });
  return {
    c,
    hash,
    ref,
    get request() {
      return githubRequest(undefined, server.transport);
    },
    urls,
    downloads: () => downloads,
    fault(value: string) {
      fault = value;
      downloaded = false;
      downloads = 0;
      urls.length = 0;
      zip =
        value === "foreign-member"
          ? foreignZip
          : value === "missing-payload"
            ? missingZip
            : originalZip;
      ref.artifactDigest = `sha256:${sha256(value === "corrupt-zip" ? Buffer.from("different compressed identity") : zip.bytes)}`;
    },
    async close() {
      await server.close();
      await originalZip.close();
      await foreignZip.close();
      await missingZip.close();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test("completed candidate job authenticates actual ZIP metadata while parent is running, without promoting source bootstrap", async () => {
  for (const [scope, job] of [
    ["release-fixture", "native"],
    [SYNTHETIC_SCOPE, "native-receipt"],
  ]) {
    const f = await fixture(scope, job);
    try {
      const reference = await resolveCurrentCandidateReference(f.c, f.hash, f.request);
      assert.deepEqual(reference, f.ref);
      await verifyCurrentCandidateRead(f.c, f.hash, reference, f.request);
      assert.equal(f.downloads(), 1);
      assert.ok(f.urls.some((url) => url.includes("/attempts/1/jobs?")));
      await assert.rejects(
        verifyProducer(f.c, "candidate", f.c.producer, f.ref, f.request),
        /completed/,
      );
      assert.equal(f.c.publishable, scope !== SYNTHETIC_SCOPE);
      if (!f.c.publishable) await assert.rejects(trustedMain(f.c, f.request), /Synthetic/);
    } finally {
      await f.close();
    }
  }
});

test("wrong caller, incomplete candidate and mismatched producer facts fail before ZIP download or payload permission", async () => {
  const f = await fixture();
  try {
    for (const fault of [
      "unfinished-candidate",
      "skipped-candidate",
      "failed-candidate",
      "duplicate-candidate",
      "missing-candidate",
      "wrong-window",
      "expired",
      "foreign-artifact",
      "foreign-run",
      "superseded",
      "main",
      "tag",
      "workflow-bytes",
    ]) {
      f.fault(fault);
      await assert.rejects(verifyCurrentCandidateRead(f.c, f.hash, f.ref, f.request), Error, fault);
      assert.equal(f.downloads(), 0, `${fault} reached ZIP before required authentication`);
    }
    f.fault("duplicate-artifact");
    await assert.rejects(resolveCurrentCandidateReference(f.c, f.hash, f.request), /duplicate/);
    for (const [key, value] of Object.entries({
      GITHUB_JOB: "publish",
      GITHUB_REPOSITORY_ID: "1",
      GITHUB_RUN_ATTEMPT: "2",
      OPERATION: "publish",
      RELEASE_SCOPE: "different",
    })) {
      f.fault("");
      const original = process.env[key];
      process.env[key] = value;
      try {
        await assert.rejects(verifyCurrentCandidateRead(f.c, f.hash, f.ref, f.request));
        assert.equal(f.urls.length, 0);
      } finally {
        process.env[key] = original;
      }
    }
    f.fault("");
    await assert.rejects(
      verifyCurrentCandidateRead(f.c, f.hash, f.ref, f.request, { job: "native-receipt" }),
    );
    assert.equal(f.urls.length, 0);
    const foreign = { ...f.c, sourceCommit: "e".repeat(40) };
    const savedSource = {
      GITHUB_SHA: process.env.GITHUB_SHA,
      SOURCE_SHA: process.env.SOURCE_SHA,
      CONFIRM: process.env.CONFIRM,
    };
    Object.assign(process.env, {
      GITHUB_SHA: foreign.sourceCommit,
      SOURCE_SHA: foreign.sourceCommit,
      CONFIRM: `candidate v${foreign.version} ${foreign.sourceCommit} ${foreign.scope}`,
    });
    try {
      const hash = sha256(`${canonicalJson(foreign)}\n`);
      await assert.rejects(
        verifyCurrentCandidateRead(foreign, hash, { ...f.ref, candidateSha256: hash }, f.request),
        (error: unknown) =>
          error instanceof assert.AssertionError &&
          error.actual === f.c.sourceCommit &&
          error.expected === foreign.sourceCommit,
      );
      assert.equal(f.urls.length, 0, "Actual Git HEAD must bind the read before API access");
    } finally {
      Object.assign(process.env, savedSource);
    }
  } finally {
    await f.close();
  }
});

test("actual ZIP/member replacement and post-await attempt/main/expiry changes never confer candidate read permission", async () => {
  for (const fault of [
    "corrupt-zip",
    "foreign-member",
    "missing-payload",
    "superseded-after-zip",
    "main-after-zip",
    "expires-after-zip",
  ]) {
    const f = await fixture();
    try {
      f.fault(fault);
      await assert.rejects(verifyCurrentCandidateRead(f.c, f.hash, f.ref, f.request), Error, fault);
      assert.equal(f.downloads(), 1, `${fault} did not reach the intended real HTTP ZIP boundary`);
    } finally {
      await f.close();
    }
  }
});
