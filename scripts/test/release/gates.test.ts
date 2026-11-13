import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { create as createTar } from "tar";
import { repository } from "../../build-workspaces.ts";
import {
  operatorConfirmedFreePlan,
  operatorFreeDecision,
  operatorFreeStatement,
} from "../../operator-free-plan.ts";
import {
  assertEvidenceReceipt,
  evidenceProducer,
  execute,
  loadCandidate,
  producer as packingProducer,
  verifyRetainedCandidate,
} from "../../prepare-release.ts";
import {
  type ArtifactReference,
  assertActualFreeDeployment,
  assertDeployment,
  assertGate,
  assertSyntheticLocalGate,
  canonicalJson,
  type DeploymentIdentity,
  freshness,
  type GateKind,
  type GateReceipt,
  githubRequest,
  integratedClaims,
  inventory,
  liveClaims,
  type ProofInput,
  REPOSITORY,
  REPOSITORY_ID,
  readJson,
  regularBytes,
  SYNTHETIC_SCOPE,
  saveJson,
  sha256,
  trustedMain,
  verifyCurrentReadiness,
  verifyPayload,
  verifyProducer,
  verifyReleaseGates,
} from "../../verify-release-gates.ts";
import {
  actualCapsule,
  candidate,
  deviceProducerJobs,
  directoryArchive,
  fact,
  httpFixture,
  jsonArchive,
  metadataArchive,
  source,
  temporary,
  workflow,
} from "./fixtures.ts";

test("evidence origin binds the actual workflow/job and synthetic observations cannot authorize a privileged gate", async () => {
  const keys = [
    "OPERATION",
    "GITHUB_ACTIONS",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_SHA",
    "GITHUB_REF",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_JOB",
    "GITHUB_EVENT_NAME",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const c = candidate();
  const hash = sha256("retained candidate fixture");
  const record = fact("claims/result.json");
  const receipt = (
    producer: GateReceipt["producer"],
    kind: GateKind = "integrated",
  ): GateReceipt => ({
    schemaVersion: 1,
    kind,
    candidateSha256: hash,
    sourceCommit: c.sourceCommit,
    scope: c.scope,
    producer,
    checkedAt: new Date().toISOString(),
    claims: [{ id: "boundary", outcome: "pass", result: record }],
    platforms: [],
    deployments: [],
    files: [record],
  });
  const server = await httpFixture((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    const name = request.url?.split("/").at(-1);
    assert.ok(["ci.yml", "release.yml", "deploy.yml"].includes(name ?? ""));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: 44, path: `.github/workflows/${name}`, state: "active" }));
  });
  try {
    for (const [workflowName, job, mode] of [
      ["ci", "policy-and-integration", "local"],
      ["release", "native", "native"],
      ["release", "publish", "local"],
      ["deploy", "operate", "live"],
    ] as const) {
      Object.assign(process.env, {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
        GITHUB_SHA: c.sourceCommit,
        GITHUB_REF: "refs/heads/main",
        GITHUB_JOB: job,
        GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/${workflowName}.yml@refs/heads/main`,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_RUN_ID: "20",
        GITHUB_RUN_ATTEMPT: "3",
      });
      const producer = await evidenceProducer(
        repository,
        c,
        mode,
        githubRequest(undefined, server.transport),
      );
      assert.equal(producer.workflowPath, `.github/workflows/${workflowName}.yml`);
      assert.equal(
        producer.workflowSha256,
        sha256(await readFile(resolve(repository, producer.workflowPath))),
      );
      assert.equal(producer.workflowId, 44);
      assert.equal(producer.runId, 20);
      const gate = receipt(producer, mode === "local" ? "integrated" : mode);
      assertEvidenceReceipt(gate, { candidate: c, hash }, producer, mode);
      assert.throws(
        () =>
          assertEvidenceReceipt(
            { ...gate, producer: c.producer },
            { candidate: c, hash },
            producer,
            mode,
          ),
        /producer differs/,
      );
      assert.throws(() =>
        assertEvidenceReceipt(
          { ...gate, candidateSha256: sha256("other candidate") },
          { candidate: c, hash },
          producer,
          mode,
        ),
      );
      process.env.GITHUB_SHA = "b".repeat(40);
      await assert.rejects(
        evidenceProducer(repository, c, mode, githubRequest(undefined, server.transport)),
      );
      process.env.GITHUB_SHA = c.sourceCommit;
      process.env.GITHUB_JOB = "candidate";
      await assert.rejects(
        evidenceProducer(repository, c, mode, githubRequest(undefined, server.transport)),
      );
    }
    c.publishable = false;
    c.scope = SYNTHETIC_SCOPE;
    c.packages = c.packages.map((p) => ({
      ...p,
      name: p.name.replace("@release-fixture/", `@${SYNTHETIC_SCOPE}/`),
    }));
    for (const event of ["push", "pull_request"] as const) {
      const ref = event === "push" ? "refs/heads/main" : "refs/pull/7/merge";
      Object.assign(process.env, {
        GITHUB_EVENT_NAME: event,
        GITHUB_JOB: "policy-and-integration",
        GITHUB_REF: ref,
        GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/ci.yml@${ref}`,
      });
      assert.equal(
        (await evidenceProducer(repository, c, "local", githubRequest(undefined, server.transport)))
          .workflowId,
        44,
      );
    }
    Object.assign(process.env, {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_JOB: "native",
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
      OPERATION: "candidate",
    });
    assert.equal(
      (await evidenceProducer(repository, c, "native", githubRequest(undefined, server.transport)))
        .workflowId,
      44,
    );
    process.env.GITHUB_JOB = "candidate";
    assert.equal(
      (
        await packingProducer(
          repository,
          false,
          "release.yml",
          githubRequest(undefined, server.transport),
        )
      ).workflowId,
      44,
    );
    assert.equal(c.publishable, false);
    delete process.env.GITHUB_ACTIONS;
    const local = await evidenceProducer(repository, c, "local");
    const gate = receipt(local);
    assertSyntheticLocalGate(gate, c, "local");
    assertEvidenceReceipt(gate, { candidate: c, hash }, local, "local");
    assert.throws(() => assertGate(gate));
    assert.throws(() => assertSyntheticLocalGate(gate, c, "native"));
    assert.throws(() =>
      assertSyntheticLocalGate({ ...gate, producer: { ...local, runId: 1 } }, c, "local"),
    );
    assert.throws(() =>
      assertSyntheticLocalGate(
        { ...gate, claims: [{ ...gate.claims[0], outcome: "fail" }] },
        c,
        "local",
      ),
    );
    assert.throws(
      () => assertSyntheticLocalGate({ ...gate, files: [] }, c, "local"),
      /Missing artifact inventory/,
    );
    assert.throws(
      () =>
        assertSyntheticLocalGate(
          { ...gate, files: [{ ...record, sha256: sha256("changed") }] },
          c,
          "local",
        ),
      /Uninventoried/,
    );
    assert.throws(() => assertSyntheticLocalGate(gate, { ...c, publishable: true }, "local"));
    await assert.rejects(
      verifyProducer(
        c,
        "integrated",
        local,
        {
          runId: 0,
          runAttempt: 0,
          artifactId: 1,
          artifactName: "local",
          artifactDigest: `sha256:${hash}`,
          candidateSha256: hash,
        },
        githubRequest(undefined, server.transport),
      ),
    );
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await server.close();
  }
});

test("actual evidence child environment carries producer metadata and only the live coordinator receives admin", async () => {
  const producer = candidate().producer;
  const code = `
    const {evidenceEnvironment,execute}=await import(${JSON.stringify(pathToFileURL(resolve(repository, "scripts/prepare-release.ts")).href)});
    for(const mode of ['local','live']) {
      const result=await execute(process.execPath,['--input-type=module','-e',
        "console.log(JSON.stringify({producer:JSON.parse(process.env.FORTIPI_EVIDENCE_PRODUCER),admin:!!process.env.FORTIPI_ADMIN_TOKEN,github:!!process.env.GITHUB_TOKEN,cf:!!process.env.CLOUDFLARE_API_TOKEN,npm:!!process.env.NPM_TOKEN,model:!!process.env.OPENAI_API_KEY}))"],
        ${JSON.stringify(repository)},evidenceEnvironment(${JSON.stringify(producer)},mode));
      if(result.code!==0)throw Error('child failed');process.stdout.write(result.stdout);
    }`;
  const result = await execute(process.execPath, ["--input-type=module", "-e", code], repository, {
    PATH: process.env.PATH,
    GITHUB_TOKEN: "synthetic-gh",
    CLOUDFLARE_API_TOKEN: "synthetic-cf",
    NPM_TOKEN: "synthetic-npm",
    OPENAI_API_KEY: "synthetic-model",
    FORTIPI_ADMIN_TOKEN: "synthetic-admin",
  });
  assert.equal(result.code, 0);
  const rows = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    rows,
    [false, true].map((admin) => ({
      producer,
      admin,
      github: false,
      cf: false,
      npm: false,
      model: false,
    })),
  );
});

test("only trusted candidate setup receives GitHub context and ordinary client children strip it", async () => {
  const c = candidate();
  const reference: ArtifactReference = {
    runId: c.producer.runId,
    runAttempt: c.producer.runAttempt,
    artifactId: 1,
    artifactName: "candidate-fixture",
    artifactDigest: `sha256:${sha256("fixture")}`,
    candidateSha256: sha256("candidate"),
  };
  const code = `
    const {evidenceEnvironment,childEnvironment,execute}=await import(${JSON.stringify(pathToFileURL(resolve(repository, "scripts/prepare-release.ts")).href)});
    const trusted=evidenceEnvironment(${JSON.stringify(c.producer)},'native',{
      kind:'current',reference:${JSON.stringify(reference)},request:()=>{throw Error('No API call in environment test')}
    });
    const result=await execute(process.execPath,['--input-type=module','-e',
      "const {childEnvironment,execute}=await import("+${JSON.stringify(JSON.stringify(pathToFileURL(resolve(repository, "scripts/prepare-release.ts")).href))}+"); const result=await execute(process.execPath,['-e', 'console.log(JSON.stringify({github:!!process.env.GITHUB_TOKEN,reference:!!process.env.FORTIPI_CANDIDATE_REFERENCE,runnerName:!!process.env.RUNNER_NAME,admin:!!process.env.FORTIPI_ADMIN_TOKEN,cf:!!process.env.CLOUDFLARE_API_TOKEN,npm:!!process.env.NPM_TOKEN,model:!!process.env.OPENAI_API_KEY}))'],process.cwd(),childEnvironment());if(result.code!==0)throw Error('client failed');console.log(JSON.stringify({trustedGithub:!!process.env.GITHUB_TOKEN,runnerName:process.env.RUNNER_NAME,operation:process.env.OPERATION,reference:JSON.parse(process.env.FORTIPI_CANDIDATE_REFERENCE),client:JSON.parse(result.stdout)}));"
    ],${JSON.stringify(repository)},trusted);
    if(result.code!==0)throw Error('trusted setup failed');process.stdout.write(result.stdout);`;
  const result = await execute(process.execPath, ["--input-type=module", "-e", code], repository, {
    PATH: process.env.PATH,
    GITHUB_TOKEN: "synthetic-github-role",
    RUNNER_NAME: "synthetic-native-runner",
    CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-role",
    NPM_TOKEN: "synthetic-npm-role",
    OPENAI_API_KEY: "synthetic-model-role",
    FORTIPI_ADMIN_TOKEN: "synthetic-admin-role",
    OPERATION: "candidate",
  });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    trustedGithub: true,
    runnerName: "synthetic-native-runner",
    operation: "candidate",
    reference,
    client: {
      github: false,
      reference: false,
      runnerName: false,
      admin: false,
      cf: false,
      npm: false,
      model: false,
    },
  });
});

test("workflow operations refuse a missing artifact reference before opening candidate payloads", async () => {
  const code = `
    const {loadWorkflowCandidate}=await import(${JSON.stringify(pathToFileURL(resolve(repository, "scripts/prepare-release.ts")).href)});
    try { await loadWorkflowCandidate('deliberately-absent-candidate.json'); process.exitCode=2; }
    catch(error) { if(!String(error.message).includes('artifact reference required'))throw error; console.log('reference-required-before-file-read'); }`;
  const result = await execute(process.execPath, ["--input-type=module", "-e", code], repository, {
    PATH: process.env.PATH,
    GITHUB_ACTIONS: "true",
    GITHUB_JOB: "operate",
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stdout.trim(), "reference-required-before-file-read");
});

test("real HTTP GitHub verification binds current attempt, paginated jobs, workflow bytes and independent archive digest", async () => {
  const c = candidate();
  const now = Date.now();
  let mutate = "";
  const calls: string[] = [];
  let leaked = false;
  const packet = await metadataArchive(c);
  let archiveBytes = packet.bytes;
  const substituted = await metadataArchive({ ...c, producer: { ...c.producer, runId: 11 } });
  const ref: ArtifactReference = {
    runId: 10,
    runAttempt: 2,
    artifactId: 70,
    artifactName: `candidate-${source}-${c.scope}-10-2`,
    artifactDigest: `sha256:${sha256(packet.bytes)}`,
    candidateSha256: packet.metadataSha256,
  };
  const server = await httpFixture((request, response) => {
    const path = request.url ?? "";
    calls.push(path);
    let value: unknown;
    const run = {
      id: 10,
      run_attempt: mutate === "superseded" ? 3 : 2,
      workflow_id: 1,
      head_sha: source,
      head_branch: "main",
      event: "workflow_dispatch",
      repository: { id: REPOSITORY_ID },
      head_repository: { id: mutate === "fork" ? 7 : REPOSITORY_ID },
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/release.yml@refs/heads/main",
      run_started_at: new Date(now - 60000).toISOString(),
      updated_at: new Date(now - 1000).toISOString(),
    };
    if (path.endsWith("/zip")) {
      response.writeHead(302, { location: "https://fixture.blob.core.windows.net/retained.zip" });
      response.end();
      return;
    }
    if (path === "/retained.zip") {
      leaked = Boolean(request.headers.authorization);
      response.end(
        mutate === "bytes"
          ? Buffer.from("changed")
          : mutate === "substitute"
            ? substituted.bytes
            : archiveBytes,
      );
      return;
    }
    if (path === `/repos/${REPOSITORY}`) value = { id: REPOSITORY_ID, full_name: REPOSITORY };
    else if (path.endsWith("/git/ref/heads/main"))
      value = { object: { sha: mutate === "main" ? "b".repeat(40) : source } };
    else if (path.includes("matching-refs"))
      value =
        mutate === "tag"
          ? [{ ref: "refs/tags/v0.1.0", object: { sha: "b".repeat(40), type: "commit" } }]
          : [];
    else if (path.endsWith("/actions/workflows/1"))
      value = { id: 1, path: ".github/workflows/release.yml", state: "active" };
    else if (path.includes("/contents/"))
      value = { encoding: "base64", content: `${Buffer.from(workflow).toString("base64")}\n` };
    else if (path.includes("/jobs?"))
      value = {
        total_count: 101,
        jobs:
          new URL(`http://fixture${path}`).searchParams.get("page") === "1"
            ? Array.from({ length: 100 }, (_, i) => ({
                name: `unrelated-${i}`,
                status: "completed",
                conclusion: "success",
                started_at: new Date(now - 50000).toISOString(),
                completed_at: new Date(now - 2000).toISOString(),
              }))
            : [
                {
                  name: "candidate",
                  status: "completed",
                  conclusion: mutate === "skipped" ? "skipped" : "success",
                  started_at: new Date(now - 50000).toISOString(),
                  completed_at: new Date(now - 2000).toISOString(),
                },
              ],
      };
    else if (path.endsWith("/actions/artifacts/70"))
      value = {
        name: ref.artifactName,
        expired: false,
        digest:
          mutate === "substitute" ? `sha256:${sha256(substituted.bytes)}` : ref.artifactDigest,
        workflow_run: {
          id: 10,
          repository_id: REPOSITORY_ID,
          head_repository_id: REPOSITORY_ID,
          head_sha: source,
          head_branch: "main",
        },
        created_at: new Date(now - 10000).toISOString(),
        expires_at: new Date(now + 3600000).toISOString(),
      };
    else if (path.includes("/actions/runs/10")) value = run;
    else {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  });
  const retained = await temporary("fortipi-retained-order-");
  const retainedPath = resolve(retained, "candidate.json");
  await saveJson(retainedPath, c);
  try {
    const api = githubRequest("synthetic-github-role", server.transport);
    await trustedMain(c, api);
    await verifyProducer(c, "candidate", c.producer, ref, api, now);
    await verifyRetainedCandidate(c, packet.metadataSha256, ref, api);
    // Deliberately absent payload: producer rejection must precede any payload walk/read.
    mutate = "superseded";
    await assert.rejects(
      loadCandidate(retainedPath, {
        reference: ref,
        request: githubRequest(undefined, server.transport),
      }),
      /Superseded attempt/,
    );
    mutate = "";
    calls.length = 0;
    await assert.rejects(
      loadCandidate(retainedPath, {
        reference: ref,
        request: githubRequest(undefined, server.transport),
      }),
      /Artifact payload differs|ENOENT/,
    );
    assert.ok(calls.includes("/retained.zip"), "Producer archive must be authenticated first");
    const beforeDenied = calls.length;
    await assert.rejects(
      loadCandidate(retainedPath, {
        kind: "current",
        reference: ref,
        request: githubRequest(undefined, server.transport),
      }),
      (error: unknown) => error instanceof Error && !/ENOENT/.test(error.message),
    );
    assert.equal(
      calls.length,
      beforeDenied,
      "Denied current context must not fall back to source or payload",
    );
    await assert.rejects(
      verifyRetainedCandidate(c, sha256("different retained candidate"), ref, api),
      /Retained candidate hash mismatch/,
    );
    assert.ok(calls.some((p) => p.endsWith("page=2")));
    assert.equal(leaked, false, "GitHub role must not reach signed storage origin");
    for (const [fault, reason] of [
      ["superseded", /Superseded/],
      ["fork", /strictly equal/],
      ["skipped", /Skipped\/failed/],
      ["bytes", /archive digest mismatch/],
    ] as const) {
      mutate = fault;
      await assert.rejects(
        verifyProducer(
          c,
          "candidate",
          c.producer,
          ref,
          githubRequest("synthetic-github-role", server.transport),
          now,
        ),
        reason,
      );
    }
    mutate = "main";
    await assert.rejects(
      trustedMain(c, githubRequest(undefined, server.transport)),
      /Main advanced/,
    );
    mutate = "tag";
    await assert.rejects(
      trustedMain(c, githubRequest(undefined, server.transport)),
      /tag conflicts/,
    );
    mutate = "";
    await verifyProducer(
      c,
      "candidate",
      c.producer,
      ref,
      githubRequest(undefined, server.transport),
      now,
    );
    mutate = "substitute";
    await assert.rejects(
      verifyProducer(
        c,
        "candidate",
        c.producer,
        { ...ref, artifactDigest: `sha256:${sha256(substituted.bytes)}` },
        githubRequest(undefined, server.transport),
        now,
      ),
      /Candidate bytes differ/,
    );
    // A synthetic successful producer over actual small package archives tests
    // the reader protocol; this fixture is not source/license approval.
    mutate = "";
    const actual = structuredClone(c);
    const sources = await temporary("fortipi-reader-pack-source-");
    let realZip: Awaited<ReturnType<typeof directoryArchive>> | undefined;
    try {
      for (const pkg of actual.packages) {
        const sourceRoot = resolve(sources, pkg.sourceName);
        const files: Record<string, Buffer> = {
          "package.json": Buffer.from(JSON.stringify({ name: pkg.name, version: pkg.version })),
        };
        if (pkg.sourceName === "fortipi-cli") {
          files["worker-assets/asset-manifest.json"] = Buffer.from("assets");
          files["node_modules/reader-fixture/index.js"] = Buffer.from("export const value = 1;\n");
        }
        pkg.entries = [];
        for (const [path, bytes] of Object.entries(files)) {
          const destination = resolve(sourceRoot, "package", path);
          await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
          await writeFile(destination, bytes, { mode: 0o600 });
          pkg.entries.push({ path, size: bytes.length, mode: 0o600, sha256: sha256(bytes) });
        }
        pkg.entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
        const tarball = resolve(retained, pkg.tarball);
        await mkdir(resolve(tarball, ".."), { recursive: true });
        await createTar({ cwd: sourceRoot, file: tarball, gzip: true }, ["package"]);
        const bytes = await regularBytes(tarball);
        pkg.sha256 = sha256(bytes);
        pkg.integrity = `sha512-${(await import("node:crypto")).createHash("sha512").update(bytes).digest("base64")}`;
      }
      await mkdir(resolve(retained, "image"), { recursive: true });
      await writeFile(resolve(retained, "sbom.json"), "{}");
      await writeFile(resolve(retained, "image/sources-and-notices.tar"), "sourcekit");
      await rm(retainedPath);
      actual.files = await inventory(retained);
      ref.candidateSha256 = await saveJson(retainedPath, actual);
      realZip = await directoryArchive(retained);
      archiveBytes = realZip.bytes;
      ref.artifactDigest = `sha256:${sha256(archiveBytes)}`;
      const loaded = await loadCandidate(retainedPath, {
        reference: ref,
        request: githubRequest(undefined, server.transport),
      });
      assert.deepEqual(loaded.candidate, actual);
      await assert.rejects(loadCandidate(retainedPath), /Unsafe artifact path/);
      const cli = actual.packages.find((pkg) => pkg.sourceName === "fortipi-cli");
      const member = cli?.entries.find((entry) => entry.path.startsWith("node_modules/"));
      assert.ok(member);
      const originalHash = member.sha256;
      member.sha256 = sha256("wrong producer member hash");
      ref.candidateSha256 = await saveJson(retainedPath, actual, false);
      await realZip.close();
      realZip = await directoryArchive(retained);
      archiveBytes = realZip.bytes;
      ref.artifactDigest = `sha256:${sha256(archiveBytes)}`;
      await assert.rejects(
        loadCandidate(retainedPath, {
          reference: ref,
          request: githubRequest(undefined, server.transport),
        }),
        /Authorized archive hash differs/,
      );
      member.sha256 = originalHash;
      assert.ok(cli);
      const oversized = resolve(retained, cli.tarball);
      await appendFile(oversized, Buffer.alloc(2 * 1024 * 1024));
      const oversizedBytes = await regularBytes(oversized);
      cli.sha256 = sha256(oversizedBytes);
      cli.integrity = `sha512-${(await import("node:crypto")).createHash("sha512").update(oversizedBytes).digest("base64")}`;
      const retainedFile = actual.files.find((file) => file.path === cli.tarball);
      assert.ok(retainedFile);
      retainedFile.sha256 = cli.sha256;
      retainedFile.size = oversizedBytes.length;
      ref.candidateSha256 = await saveJson(retainedPath, actual, false);
      await realZip.close();
      realZip = await directoryArchive(retained);
      archiveBytes = realZip.bytes;
      ref.artifactDigest = `sha256:${sha256(archiveBytes)}`;
      await assert.rejects(
        loadCandidate(retainedPath, {
          reference: ref,
          request: githubRequest(undefined, server.transport),
        }),
        /Archive compressed input bound/,
      );
    } finally {
      await realZip?.close();
      await rm(sources, { recursive: true, force: true });
    }
  } finally {
    await server.close();
    await packet.close();
    await substituted.close();
    await rm(retained, { recursive: true, force: true });
  }
});

test("current readiness uses completed per-slot job and actual archive while its parent run is still in progress", async () => {
  const c = candidate();
  const now = Date.now();
  const hash = sha256("current candidate");
  const root = await temporary("fortipi-current-readiness-");
  const d: DeploymentIdentity = {
    schemaVersion: 1,
    candidateSha256: hash,
    sourceCommit: source,
    accountBindingSha256: sha256("synthetic-account"),
    slot: "paid-validation",
    workerName: "fortipi-paid",
    origin: "https://fortipi-paid.example.workers.dev",
    workerVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    deploymentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    versions: [{ versionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", percentage: 100 }],
    configSha256: sha256("prepared"),
    runtimeConfigSha256: sha256("runtime"),
    assetManifestSha256: c.assetManifestSha256,
    publicConfigurationVersion: 1,
    capabilities: { plan: "paid", loaders: true, containers: false },
    backend: "cloud-js",
    imageDigest: null,
    checkedAt: new Date(now - 2000).toISOString(),
  };
  const ready = {
    schemaVersion: 1,
    candidateSha256: hash,
    sourceCommit: source,
    checkedAt: d.checkedAt,
    deployments: [d],
  };
  const path = resolve(root, "readiness.json");
  await writeFile(path, `${canonicalJson(ready)}\n`);
  let zip = await jsonArchive(ready, "readiness.json");
  let zipDelay = 0;
  const ref: ArtifactReference = {
    runId: 20,
    runAttempt: 2,
    artifactId: 80,
    artifactName: `refresh-cloud-js-${source}-${c.scope}-20-2`,
    artifactDigest: `sha256:${sha256(zip.bytes)}`,
    candidateSha256: hash,
  };
  let fault = "";
  const originalRun = process.env.GITHUB_RUN_ID,
    originalAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ID = "20";
  process.env.GITHUB_RUN_ATTEMPT = "2";
  const server = await httpFixture((request, response) => {
    const route = request.url ?? "";
    let value: unknown;
    if (route.endsWith("/zip")) {
      response.writeHead(302, { location: "https://fixture.blob.core.windows.net/ready.zip" });
      response.end();
      return;
    }
    if (route === "/ready.zip") {
      setTimeout(() => response.end(zip.bytes), zipDelay);
      return;
    }
    if (route === `/repos/${REPOSITORY}`) value = { id: REPOSITORY_ID, full_name: REPOSITORY };
    else if (route.endsWith("/git/ref/heads/main")) value = { object: { sha: source } };
    else if (route.includes("matching-refs")) value = [];
    else if (route.includes("/contents/"))
      value = { encoding: "base64", content: Buffer.from(workflow).toString("base64") };
    else if (route.includes("/jobs?"))
      value = {
        total_count: 1,
        jobs: [
          {
            name: "readiness (cloud-js)",
            status: "completed",
            conclusion: fault === "skipped" ? "skipped" : "success",
            started_at: new Date(now - 10000).toISOString(),
            completed_at: new Date(now - 1000).toISOString(),
          },
        ],
      };
    else if (route.endsWith("/actions/artifacts/80"))
      value = {
        name: ref.artifactName,
        expired: false,
        digest: ref.artifactDigest,
        workflow_run: {
          id: 20,
          head_sha: source,
          head_branch: "main",
          repository_id: REPOSITORY_ID,
          head_repository_id: REPOSITORY_ID,
        },
        created_at: new Date(now - 3000).toISOString(),
        expires_at: new Date(now + 60000).toISOString(),
      };
    else if (route.includes("/actions/runs/20"))
      value = {
        id: 20,
        run_attempt: fault === "superseded" ? 3 : 2,
        workflow_id: 1,
        head_sha: source,
        head_branch: "main",
        event: "workflow_dispatch",
        path: ".github/workflows/release.yml",
        repository: { id: REPOSITORY_ID },
        head_repository: { id: REPOSITORY_ID },
        status: "in_progress",
        conclusion: null,
      };
    else {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  });
  try {
    assert.deepEqual(
      await verifyCurrentReadiness(
        c,
        hash,
        path,
        ref,
        githubRequest(undefined, server.transport),
        "readiness",
        now,
      ),
      [d],
    );
    fault = "skipped";
    await assert.rejects(
      verifyCurrentReadiness(
        c,
        hash,
        path,
        ref,
        githubRequest(undefined, server.transport),
        "readiness",
        now,
      ),
    );
    fault = "superseded";
    await assert.rejects(
      verifyCurrentReadiness(
        c,
        hash,
        path,
        ref,
        githubRequest(undefined, server.transport),
        "readiness",
        now,
      ),
    );
    fault = "";
    await writeFile(
      path,
      `${canonicalJson({ ...ready, deployments: [{ ...d, accountBindingSha256: sha256("borrowed target") }] })}\n`,
    );
    await assert.rejects(
      verifyCurrentReadiness(
        c,
        hash,
        path,
        ref,
        githubRequest(undefined, server.transport),
        "readiness",
        now,
      ),
      /bytes differ/,
    );
    await writeFile(path, `${canonicalJson(ready)}\n`);
    await assert.rejects(
      verifyCurrentReadiness(
        c,
        hash,
        path,
        ref,
        githubRequest(undefined, server.transport),
        "readiness",
        now + 16 * 60000,
      ),
    );
    const replaceReadiness = async (checkedAt: string) => {
      const old = zip;
      d.checkedAt = checkedAt;
      ready.checkedAt = checkedAt;
      zip = await jsonArchive(ready, "readiness.json");
      await old.close();
      ref.artifactDigest = `sha256:${sha256(zip.bytes)}`;
      await writeFile(path, `${canonicalJson(ready)}\n`);
    };
    // Actual clock and delayed HTTP/ZIP: no mocked Date or refreshed old proof.
    await replaceReadiness(new Date(Date.now() - 899000).toISOString());
    zipDelay = 1800;
    await assert.rejects(
      verifyCurrentReadiness(
        c,
        hash,
        path,
        ref,
        githubRequest(undefined, server.transport),
        "readiness",
      ),
      /Stale\/future proof/,
    );
    assert.ok(Date.now() - Date.parse(ready.checkedAt) > 900000);
    zipDelay = 0;
    await replaceReadiness(new Date().toISOString());
    assert.deepEqual(
      await verifyCurrentReadiness(
        c,
        hash,
        path,
        ref,
        githubRequest(undefined, server.transport),
        "readiness",
      ),
      [d],
    );
  } finally {
    if (originalRun === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = originalRun;
    if (originalAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = originalAttempt;
    await server.close();
    await zip.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("complete API/ZIP proof set requires all three target rows with distinct accounts and independent producers", async () => {
  // These are synthetic producer/claim observations over real HTTP and ZIP transport, not runtime acceptance.
  const root = await temporary("fortipi-full-gate-");
  const c = candidate();
  const candidateZip = await metadataArchive(c);
  const hash = candidateZip.metadataSha256;
  const now = Date.now();
  const proofs: ProofInput[] = [];
  const packets = new Map<number, { bytes: Buffer; close: () => Promise<void> }>();
  packets.set(70, candidateZip);
  const candidateRef: ArtifactReference = {
    runId: 10,
    runAttempt: 2,
    artifactId: 70,
    artifactName: `candidate-${source}-${c.scope}-10-2`,
    artifactDigest: `sha256:${sha256(candidateZip.bytes)}`,
    candidateSha256: hash,
  };
  const rules: Record<GateKind, { path: string; jobs: string[] }> = {
    candidate: { path: "release.yml", jobs: ["candidate"] },
    integrated: { path: "ci.yml", jobs: ["policy-and-integration"] },
    native: {
      path: "release.yml",
      jobs: [
        "native (ubuntu-24.04)",
        "native (macos-15)",
        "native (windows-2025)",
        "native-receipt",
      ],
    },
    access: { path: "access-preflight.yml", jobs: ["cloudflare", "npm"] },
    live: { path: "deploy.yml", jobs: deviceProducerJobs },
    independent: { path: "deploy.yml", jobs: deviceProducerJobs },
    readiness: { path: "deploy.yml", jobs: ["operate"] },
  };
  const runs = new Map<
    number,
    { kind: GateKind; artifact: ArtifactReference; workflowId: number }
  >();
  runs.set(10, { kind: "candidate", artifact: candidateRef, workflowId: 1 });
  const freeDecision = operatorFreeDecision();
  assert.ok(freeDecision, "Intended-account Free decision must be bound before this fixture");
  const deployments: DeploymentIdentity[] = (["free", "cloud-js", "linux"] as const).map(
    (backend, index) => ({
      schemaVersion: 1,
      candidateSha256: hash,
      sourceCommit: source,
      accountBindingSha256:
        backend === "free"
          ? freeDecision.accountBindingSha256
          : sha256(`synthetic account ${index}`),
      ...(backend === "free" ? { planProvenance: freeDecision } : {}),
      slot: index === 0 ? "production" : "paid-validation",
      workerName: `fortipi-${backend}`,
      origin: `https://fortipi-${backend}.example.workers.dev`,
      workerVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      deploymentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      versions: [{ versionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", percentage: 100 }],
      configSha256: sha256(`prepared ${backend}`),
      runtimeConfigSha256: sha256(`runtime ${backend}`),
      assetManifestSha256: c.assetManifestSha256,
      publicConfigurationVersion: 1,
      capabilities: {
        plan: backend === "free" ? "free" : "paid",
        loaders: backend === "cloud-js",
        containers: backend === "linux",
      },
      backend,
      imageDigest: backend === "linux" ? c.image.builtManifestDigest : null,
      checkedAt: new Date(now - 2000).toISOString(),
    }),
  );
  const add = async (kind: Exclude<GateKind, "candidate">, deployment?: DeploymentIdentity) => {
    const id = 20 + proofs.length;
    const path = resolve(root, String(id));
    await mkdir(path);
    const ids =
      kind === "integrated"
        ? [...integratedClaims]
        : kind === "native"
          ? ["portable-daemon-linux", "portable-daemon-darwin", "portable-daemon-win32"]
          : kind === "access"
            ? ["access"]
            : kind === "readiness"
              ? ["readiness"]
              : liveClaims.filter(
                  (value) => value !== "real-cloud-tools" || deployment?.backend !== "free",
                );
    for (const claim of ids) await writeFile(resolve(path, `${claim}.json`), "{}", { mode: 0o600 });
    const files = await inventory(path);
    const receipt: GateReceipt = {
      schemaVersion: 1,
      kind,
      candidateSha256: hash,
      sourceCommit: source,
      scope: c.scope,
      producer: {
        workflowPath: `.github/workflows/${rules[kind].path}`,
        workflowSha256: sha256(workflow),
        workflowId: id,
        runId: id,
        runAttempt: 1,
      },
      checkedAt: new Date(now - 2000).toISOString(),
      claims: ids.map((id) => {
        const result = files.find((f) => f.path === `${id}.json`);
        assert.ok(result);
        return { id, outcome: "pass", result };
      }),
      platforms: kind === "native" ? ["linux", "darwin", "win32"] : [],
      deployments: deployment ? [deployment] : [],
      files,
    };
    await saveJson(resolve(path, "gate.json"), receipt);
    const zip = await directoryArchive(path);
    packets.set(id + 100, zip);
    const artifact: ArtifactReference = {
      runId: id,
      runAttempt: 1,
      artifactId: id + 100,
      artifactName: `${kind}-${source}-${c.scope}-${id}-1`,
      artifactDigest: `sha256:${sha256(zip.bytes)}`,
      candidateSha256: hash,
    };
    proofs.push({ receipt, artifact, directory: path });
    runs.set(id, { kind, artifact, workflowId: id });
  };
  for (const kind of ["integrated", "native", "access"] as const) await add(kind);
  for (const kind of ["live", "independent", "readiness"] as const)
    for (const d of deployments) await add(kind, d);
  const server = await httpFixture((request, response) => {
    const route = request.url ?? "";
    let value: unknown;
    const runMatch = route.match(/\/actions\/runs\/(\d+)/);
    const artifactMatch = route.match(/\/actions\/artifacts\/(\d+)/);
    const workflowMatch = route.match(/\/actions\/workflows\/(\d+)/);
    if (route.startsWith("/zips/")) {
      const packet = packets.get(Number(route.split("/")[2]));
      assert.ok(packet);
      response.end(packet.bytes);
      return;
    }
    if (artifactMatch && route.endsWith("/zip")) {
      response.writeHead(302, {
        location: `https://fixture.blob.core.windows.net/zips/${artifactMatch[1]}`,
      });
      response.end();
      return;
    }
    if (route === `/repos/${REPOSITORY}`) value = { id: REPOSITORY_ID, full_name: REPOSITORY };
    else if (route.endsWith("/git/ref/heads/main")) value = { object: { sha: source } };
    else if (route.includes("matching-refs")) value = [];
    else if (route.includes("/contents/"))
      value = { encoding: "base64", content: Buffer.from(workflow).toString("base64") };
    else if (workflowMatch) {
      const item = [...runs.values()].find((r) => r.workflowId === Number(workflowMatch[1]));
      assert.ok(item);
      value = {
        id: item.workflowId,
        path: `.github/workflows/${rules[item.kind].path}`,
        state: "active",
      };
    } else if (artifactMatch) {
      const item = [...runs.values()].find(
        (r) => r.artifact.artifactId === Number(artifactMatch[1]),
      );
      assert.ok(item);
      value = {
        name: item.artifact.artifactName,
        digest: item.artifact.artifactDigest,
        expired: false,
        workflow_run: {
          id: item.artifact.runId,
          repository_id: REPOSITORY_ID,
          head_repository_id: REPOSITORY_ID,
          head_sha: source,
          head_branch: "main",
        },
        created_at: new Date(now - 3000).toISOString(),
        expires_at: new Date(now + 60000).toISOString(),
      };
    } else if (runMatch) {
      const item = runs.get(Number(runMatch[1]));
      assert.ok(item);
      value = route.includes("/jobs?")
        ? {
            total_count: rules[item.kind].jobs.length,
            jobs: rules[item.kind].jobs.map((name) => ({
              name,
              status: "completed",
              conclusion: "success",
              started_at: new Date(now - 10000).toISOString(),
              completed_at: new Date(now - 1000).toISOString(),
            })),
          }
        : {
            id: item.artifact.runId,
            run_attempt: item.artifact.runAttempt,
            workflow_id: item.workflowId,
            head_sha: source,
            head_branch: "main",
            event: "workflow_dispatch",
            repository: { id: REPOSITORY_ID },
            head_repository: { id: REPOSITORY_ID },
            path: `.github/workflows/${rules[item.kind].path}`,
            status: "completed",
            conclusion: "success",
            run_started_at: new Date(now - 20000).toISOString(),
            updated_at: new Date(now - 1000).toISOString(),
          };
    } else {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  });
  try {
    await verifyReleaseGates(
      c,
      hash,
      candidateRef,
      proofs,
      githubRequest(undefined, server.transport),
      now,
    );
    await assert.rejects(
      verifyReleaseGates(
        c,
        hash,
        candidateRef,
        proofs.filter(
          (p) => !(p.receipt.kind === "live" && p.receipt.deployments[0]?.backend === "linux"),
        ),
        githubRequest(undefined, server.transport),
        now,
      ),
      /required Free or paid target/,
    );
    const originalJobs = rules.live.jobs;
    rules.live.jobs = originalJobs.filter((name) => name !== "live-device-cleanup");
    try {
      await assert.rejects(
        verifyReleaseGates(
          c,
          hash,
          candidateRef,
          proofs,
          githubRequest(undefined, server.transport),
          now,
        ),
        /Missing\/duplicate required job/,
      );
    } finally {
      rules.live.jobs = originalJobs;
    }
  } finally {
    await server.close();
    for (const packet of packets.values()) await packet.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt hashes and fixed freshness reject changed results, unavailable claims and split rollout", async () => {
  const root = await temporary("fortipi-gates-");
  try {
    await writeFile(resolve(root, "result.json"), "{}", { mode: 0o600 });
    const files = await inventory(root);
    await chmod(resolve(root, "result.json"), 0o644);
    await verifyPayload(root, files);
    const c = candidate();
    const receipt: GateReceipt = {
      schemaVersion: 1,
      kind: "integrated",
      candidateSha256: sha256("candidate"),
      sourceCommit: source,
      scope: c.scope,
      producer: c.producer,
      checkedAt: new Date().toISOString(),
      claims: [{ id: "admission-durability", outcome: "pass", result: files[0] ?? fact() }],
      platforms: [],
      deployments: [],
      files,
    };
    assertGate(receipt);
    await verifyPayload(root, receipt.files);
    // Keep the length unchanged so this remains a hash-binding control.
    await writeFile(resolve(root, "result.json"), "[]");
    await assert.rejects(verifyPayload(root, receipt.files), /payload differs/);
    assert.throws(
      () => assertGate({ ...receipt, claims: [{ ...receipt.claims[0], outcome: "unavailable" }] }),
      /claim did not pass/,
    );
    assert.throws(() => freshness(new Date(Date.now() - 16 * 60000).toISOString(), 0.25), /Stale/);
    assert.throws(() => freshness(new Date(Date.now() + 61000).toISOString(), 24), /future/);
    const d: DeploymentIdentity = {
      schemaVersion: 1,
      candidateSha256: receipt.candidateSha256,
      sourceCommit: source,
      accountBindingSha256: sha256("a".repeat(32)),
      slot: "production",
      workerName: "fortipi-fixture",
      origin: "https://fortipi-fixture.example.workers.dev",
      workerVersionId: `${"a".repeat(8)}-aaaa-aaaa-aaaa-${"a".repeat(12)}`,
      deploymentId: `${"b".repeat(8)}-bbbb-bbbb-bbbb-${"b".repeat(12)}`,
      versions: [],
      configSha256: sha256("config"),
      runtimeConfigSha256: sha256("runtime"),
      assetManifestSha256: c.assetManifestSha256,
      publicConfigurationVersion: 0,
      capabilities: { plan: "free", loaders: false, containers: false },
      backend: "free",
      imageDigest: null,
      checkedAt: new Date().toISOString(),
    };
    d.versions = [{ versionId: d.workerVersionId, percentage: 100 }];
    assertDeployment(d);
    assert.throws(() => assertActualFreeDeployment(d), /Free plan/);
    const decision = operatorFreeDecision();
    assert.ok(decision, "Intended-account Free decision must be bound before this fixture");
    assert.equal(decision.statementAt, null, "Original assertion time must stay unknown");
    assert.equal(decision.statementSha256, sha256(operatorFreeStatement));
    const confirmed = {
      ...d,
      accountBindingSha256: decision.accountBindingSha256,
      planProvenance: decision,
    };
    assertActualFreeDeployment(confirmed);
    const foreign = sha256("foreign synthetic operator account");
    assert.notEqual(foreign, decision.accountBindingSha256);
    assert.equal(operatorConfirmedFreePlan(foreign), undefined);
    for (const fault of [
      "missing",
      "foreign",
      "superseded",
      "statement",
      "unknown",
      "paid",
    ] as const) {
      const changed = structuredClone(confirmed);
      if (fault === "missing") Reflect.deleteProperty(changed, "planProvenance");
      else if (fault === "foreign") changed.accountBindingSha256 = foreign;
      else if (fault === "superseded") changed.planProvenance.recordedAt = "2000-01-01T00:00:00Z";
      else if (fault === "statement")
        changed.planProvenance.statementSha256 = sha256("other statement");
      else if (fault === "unknown") changed.capabilities.plan = "unknown";
      else {
        changed.backend = "cloud-js";
        changed.capabilities = { plan: "paid", loaders: true, containers: false };
      }
      assert.throws(() => assertActualFreeDeployment(changed), Error, fault);
    }
    const returned = operatorConfirmedFreePlan(decision.accountBindingSha256);
    assert.ok(returned);
    returned.recordedAt = "2099-01-01T00:00:00Z";
    assert.deepEqual(
      operatorFreeDecision(),
      decision,
      "Returned data cannot change source authority",
    );
    assertActualFreeDeployment({ ...confirmed, checkedAt: new Date(Date.now() + 1).toISOString() });
    assert.equal(confirmed.planProvenance.recordedAt, decision.recordedAt);
    assert.throws(
      () =>
        assertDeployment({ ...d, versions: [{ versionId: d.workerVersionId, percentage: 99 }] }),
      /Nonexclusive/,
    );
    assert.throws(() =>
      assertDeployment({ ...d, capabilities: { ...d.capabilities, loaders: true } }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native aggregation preserves transported bytes/modes and the original observation age", {
  timeout: 60000,
}, async (t) => {
  const root = await temporary("fortipi-native-enforcement-");
  const path = await actualCapsule(resolve(root, "candidate"));
  const loaded = await loadCandidate(path);
  const input = resolve(root, "input");
  await mkdir(input);
  const times = [1, 2, 3].map((hours) => new Date(Date.now() - hours * 3600000).toISOString());
  const original = new Map<string, Buffer>();
  for (const [index, platform] of ["darwin", "linux", "win32"].entries()) {
    const directory = resolve(input, platform);
    await mkdir(directory);
    await saveJson(resolve(directory, "result.json"), { platform, syntheticObservation: true });
    const files = await inventory(directory);
    const result = files[0];
    assert.ok(result);
    const gate: GateReceipt = {
      schemaVersion: 1,
      kind: "native",
      candidateSha256: loaded.hash,
      sourceCommit: loaded.candidate.sourceCommit,
      scope: loaded.candidate.scope,
      producer: { ...loaded.candidate.producer, workflowId: 1, runId: 10, runAttempt: 1 },
      checkedAt: String(times[index]),
      claims: [{ id: "portable-daemon", outcome: "pass", result }],
      platforms: [platform as "darwin" | "linux" | "win32"],
      deployments: [],
      files,
    };
    assertGate(gate);
    await saveJson(resolve(directory, "gate.json"), gate);
    original.set(platform, await readFile(resolve(directory, "gate.json")));
  }
  const server = await httpFixture((request, response) => {
    assert.equal(request.url, "/repos/scottdraper8/fortipi/actions/workflows/release.yml");
    response.setHeader("content-type", "application/json");
    response.end('{"id":1}');
  });
  const aggregate = async (name: string) =>
    execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    const original=globalThis.fetch;
    globalThis.fetch=(url,options)=>original(${JSON.stringify(server.origin)}+new URL(url).pathname,options);
    const {aggregateNative}=await import(${JSON.stringify(pathToFileURL(resolve(repository, "scripts/prepare-release.ts")).href)});
    try { await aggregateNative(${JSON.stringify(path)},${JSON.stringify(input)},${JSON.stringify(resolve(root, name))}); }
    catch(error) { console.log(error.message); process.exitCode=1; }
  `,
      ],
      repository,
      {
        PATH: process.env.PATH,
        LANG: "C",
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_RUN_ID: "20",
        GITHUB_RUN_ATTEMPT: "1",
      },
      30000,
    );
  try {
    await t.test(
      "0644 ZIP transport changes no receipt/result bytes or tar bin modes",
      async () => {
        const control = await aggregate("mode600");
        assert.equal(control.code, 0, control.stdout);
        for (const platform of original.keys()) {
          const directory = resolve(input, platform);
          await chmod(resolve(directory, "result.json"), 0o644);
          await chmod(resolve(directory, "gate.json"), 0o644);
          const gate = await readJson(resolve(directory, "gate.json"));
          assertGate(gate);
          await verifyPayload(directory, gate.files, ["gate.json"]);
        }
        const transported = await aggregate("mode644");
        assert.equal(transported.code, 0, transported.stdout);
        const gate = await readJson(resolve(root, "mode644/gate.json"));
        assertGate(gate);
        for (const claim of gate.claims) {
          assert.equal(claim.result.mode, 0o644);
          assert.ok(gate.files.some((f) => canonicalJson(f) === canonicalJson(claim.result)));
        }
        for (const [platform, bytes] of original)
          assert.deepEqual(await readFile(resolve(root, "mode644", platform, "gate.json")), bytes);
        assert.deepEqual((await loadCandidate(path)).candidate.packages, loaded.candidate.packages);
      },
    );
    await t.test(
      "25-hour input is refused and fresh aggregation retains the oldest observation",
      async () => {
        for (const platform of original.keys()) {
          const target = resolve(input, platform, "gate.json");
          await chmod(resolve(input, platform, "result.json"), 0o600);
          await chmod(target, 0o600);
          const gate = await readJson(target);
          assertGate(gate);
          gate.checkedAt = new Date(Date.now() - 25 * 3600000).toISOString();
          assert.throws(() => freshness(gate.checkedAt, 24), /Stale\/future/);
          await saveJson(target, gate, false);
        }
        const stale = await aggregate("stale");
        assert.notEqual(stale.code, 0, "Expired native evidence was renewed without execution");
        assert.match(stale.stdout, /Stale\/future proof/);
        for (const [platform, bytes] of original)
          await writeFile(resolve(input, platform, "gate.json"), bytes);
        const fresh = await aggregate("oldest");
        assert.equal(fresh.code, 0, fresh.stdout);
        const gate = await readJson(resolve(root, "oldest/gate.json"));
        assertGate(gate);
        assert.equal(gate.checkedAt, times[2]);
      },
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
