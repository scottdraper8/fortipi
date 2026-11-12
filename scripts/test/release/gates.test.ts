import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repository } from "../../build-workspaces.ts";
import { execute, loadCandidate } from "../../prepare-release.ts";
import {
  type ArtifactReference,
  assertDeployment,
  assertGate,
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
  directoryArchive,
  fact,
  httpFixture,
  jsonArchive,
  metadataArchive,
  source,
  temporary,
  workflow,
} from "./fixtures.ts";

test("real HTTP GitHub verification binds current attempt, paginated jobs, workflow bytes and independent archive digest", async () => {
  const c = candidate();
  const now = Date.now();
  let mutate = "";
  const calls: string[] = [];
  let leaked = false;
  const packet = await metadataArchive(c);
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
            : packet.bytes,
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
  try {
    const api = githubRequest("synthetic-github-role", server.transport);
    await trustedMain(c, api);
    await verifyProducer(c, "candidate", c.producer, ref, api, now);
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
  } finally {
    await server.close();
    await packet.close();
    await substituted.close();
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
    live: { path: "deploy.yml", jobs: ["operate"] },
    independent: { path: "deploy.yml", jobs: ["operate"] },
    readiness: { path: "deploy.yml", jobs: ["operate"] },
  };
  const runs = new Map<
    number,
    { kind: GateKind; artifact: ArtifactReference; workflowId: number }
  >();
  runs.set(10, { kind: "candidate", artifact: candidateRef, workflowId: 1 });
  const deployments: DeploymentIdentity[] = (["free", "cloud-js", "linux"] as const).map(
    (backend, index) => ({
      schemaVersion: 1,
      candidateSha256: hash,
      sourceCommit: source,
      accountBindingSha256: sha256(`synthetic account ${index}`),
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
    await writeFile(resolve(root, "result.json"), '{"forged":true}');
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
