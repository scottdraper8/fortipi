import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { readLocalInfrastructureProof } from "../../live-infrastructure-local.ts";
import {
  type ArtifactReference,
  canonicalJson,
  type GateReceipt,
  githubRequest,
  integratedClaims,
  inventory,
  REPOSITORY,
  REPOSITORY_ID,
  saveJson,
  sha256,
} from "../../verify-release-gates.ts";
import { candidate, directoryArchive, discard, httpFixture, temporary } from "./fixtures.ts";

// Controlled completed-producer protocol fixture; not an actual GitHub gate or
// a claim that the synthetic result satisfies Chief's detailed scenario oracle.
async function fixture() {
  const root = await temporary("fortipi-infrastructure-local-");
  const payload = resolve(root, "payload"),
    proofsPath = resolve(root, "proofs.json");
  const c = candidate(),
    candidateSha256 = sha256(`${canonicalJson(c)}\n`),
    now = Date.now();
  const workflow = "synthetic immutable CI source\n";
  const producer = {
    workflowPath: ".github/workflows/ci.yml",
    workflowSha256: sha256(workflow),
    workflowId: 7,
    runId: 17,
    runAttempt: 2,
  };
  for (const id of integratedClaims)
    await saveJson(resolve(payload, `claims/${id}.json`), {
      id,
      outcome: "pass",
      identity: { sourceCommit: c.sourceCommit, candidateSha256 },
      observation: { label: "alpha" },
    });
  const files = await inventory(payload);
  const gate: GateReceipt = {
    schemaVersion: 1,
    kind: "integrated",
    candidateSha256,
    sourceCommit: c.sourceCommit,
    scope: c.scope,
    producer,
    checkedAt: new Date(now).toISOString(),
    claims: integratedClaims.map((id) => {
      const result = files.find((f) => f.path === `claims/${id}.json`);
      assert.ok(result);
      return { id, outcome: "pass", result };
    }),
    platforms: [],
    deployments: [],
    files,
  };
  await saveJson(resolve(payload, "gate.json"), gate);
  const gateBytes = await readFile(resolve(payload, "gate.json"));
  const resultPath = resolve(payload, "claims/infrastructure-boundaries.json");
  const resultBytes = await readFile(resultPath);
  const archive = await directoryArchive(payload);
  const reference: ArtifactReference = {
    runId: 17,
    runAttempt: 2,
    artifactId: 70,
    artifactName: `integrated-${c.sourceCommit}-${c.scope}-17-2`,
    artifactDigest: `sha256:${sha256(archive.bytes)}`,
    candidateSha256,
  };
  const bundle = {
    schemaVersion: 1,
    candidateArtifact: { ...reference, artifactId: 71, artifactName: "candidate-protocol-fixture" },
    proofs: [{ artifact: reference, directory: payload }],
  };
  await saveJson(proofsPath, bundle);
  let fault = "",
    downloads = 0,
    authorizationLeaked = false;
  const seen: string[] = [];
  const server = await httpFixture((request, response) => {
    const path = request.url ?? "";
    seen.push(path);
    assert.equal(request.method, "GET");
    if (path.endsWith("/zip")) {
      assert.equal(request.headers.authorization, "Bearer synthetic-retained-proof-reader");
      response.writeHead(302, { location: "https://fixture.blob.core.windows.net/integrated.zip" });
      response.end();
      return;
    }
    if (path === "/integrated.zip") {
      authorizationLeaked ||= Boolean(request.headers.authorization);
      downloads++;
      response.end(fault === "digest" ? Buffer.from("changed archive bytes") : archive.bytes);
      return;
    }
    assert.equal(request.headers.authorization, "Bearer synthetic-retained-proof-reader");
    const base = `/repos/${REPOSITORY}`;
    let value: unknown;
    if (path === `${base}/actions/workflows/7`)
      value = { id: 7, path: producer.workflowPath, state: "active" };
    else if (path.includes("/contents/"))
      value = { encoding: "base64", content: Buffer.from(workflow).toString("base64") };
    else if (path.endsWith("/jobs?per_page=100&page=1"))
      value = {
        total_count: 1,
        jobs: [
          {
            name: "policy-and-integration",
            status: "completed",
            conclusion: "success",
            started_at: new Date(now - 50000).toISOString(),
            completed_at: new Date(now - 2000).toISOString(),
          },
        ],
      };
    else if (path === `${base}/actions/artifacts/70`)
      value = {
        name: reference.artifactName,
        digest: reference.artifactDigest,
        expired: false,
        workflow_run: {
          id: 17,
          repository_id: REPOSITORY_ID,
          head_repository_id: REPOSITORY_ID,
          head_sha: c.sourceCommit,
          head_branch: "main",
        },
        created_at: new Date(now - 10000).toISOString(),
        expires_at: new Date(now + 3600000).toISOString(),
      };
    else if (path === `${base}/actions/runs/17` || path === `${base}/actions/runs/17/attempts/2`)
      value = {
        id: 17,
        run_attempt: 2,
        workflow_id: 7,
        head_sha: fault === "source" ? "b".repeat(40) : c.sourceCommit,
        head_branch: "main",
        event: "push",
        repository: { id: REPOSITORY_ID },
        head_repository: { id: REPOSITORY_ID },
        status: "completed",
        conclusion: "success",
        path: `${producer.workflowPath}@refs/heads/main`,
        run_started_at: new Date(now - 60000).toISOString(),
        updated_at: new Date(now - 1000).toISOString(),
      };
    else {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  });
  const read = () =>
    readLocalInfrastructureProof({
      candidate: c,
      candidateSha256,
      proofsPath,
      request: githubRequest("synthetic-retained-proof-reader", server.transport),
      now,
    });
  return {
    c,
    candidateSha256,
    now,
    gate,
    gateBytes,
    resultBytes,
    resultPath,
    payload,
    proofsPath,
    reference,
    bundle,
    seen,
    read,
    setFault(value: string) {
      fault = value;
    },
    get downloads() {
      return downloads;
    },
    get authorizationLeaked() {
      return authorizationLeaked;
    },
    async close() {
      await server.close();
      await archive.close();
      await discard(root);
    },
  };
}

test("completed HTTP/ZIP integrated predecessor returns original bounded canonical JSON and actual reference data", async () => {
  const f = await fixture();
  try {
    const result = await f.read();
    assert.deepEqual(Object.keys(result).sort(), ["gateJson", "reference", "resultJson"]);
    assert.deepEqual(result.reference, f.reference);
    assert.equal(result.gateJson, f.gateBytes.toString("utf8"));
    assert.equal(result.resultJson, f.resultBytes.toString("utf8"));
    assert.ok(Buffer.byteLength(result.gateJson) + Buffer.byteLength(result.resultJson) <= 750000);
    assert.equal(f.downloads, 1);
    assert.equal(f.authorizationLeaked, false);
    assert.deepEqual(await readFile(resolve(f.payload, "gate.json")), f.gateBytes);
    assert.deepEqual(await readFile(f.resultPath), f.resultBytes);
  } finally {
    await f.close();
  }
});

test("actual archive digest/source and local result swaps cannot become authenticated predecessor data", async () => {
  const f = await fixture();
  try {
    f.setFault("digest");
    await assert.rejects(f.read(), /archive digest mismatch/);
    f.setFault("source");
    await rm(f.resultPath);
    await assert.rejects(
      f.read(),
      /Expected values to be strictly equal/,
      "Actual producer source must reject before the deliberately missing result payload",
    );
    f.setFault("");
    await writeFile(f.resultPath, f.resultBytes.toString("utf8").replace("alpha", "omega"));
    await assert.rejects(f.read(), /payload differs/);
    assert.equal(f.authorizationLeaked, false);
  } finally {
    await f.close();
  }
});

test("partial, foreign, noncanonical and oversized gate/result handoffs reject before any archive authority", async () => {
  const f = await fixture();
  try {
    const scenarios = [
      {
        mutate(g: GateReceipt) {
          g.claims.pop();
        },
        expected: /Partial integrated/,
      },
      {
        mutate(g: GateReceipt) {
          g.scope = "foreign-scope";
        },
        expected: /Expected values/,
      },
      {
        mutate(g: GateReceipt) {
          g.candidateSha256 = sha256("foreign candidate");
        },
        expected: /Expected values/,
      },
      {
        mutate(g: GateReceipt) {
          for (const row of g.files)
            if (row.path === "claims/infrastructure-boundaries.json") row.size = 750000;
          for (const row of g.claims)
            if (row.id === "infrastructure-boundaries") row.result.size = 750000;
        },
        expected: /Combined infrastructure JSON byte bound/,
      },
    ];
    for (const { mutate, expected } of scenarios) {
      const gate = structuredClone(f.gate);
      mutate(gate);
      await writeFile(resolve(f.payload, "gate.json"), `${canonicalJson(gate)}\n`);
      await assert.rejects(f.read(), expected);
      assert.equal(f.seen.length, 0);
    }
    await writeFile(resolve(f.payload, "gate.json"), ` ${f.gateBytes.toString("utf8")}`);
    await assert.rejects(f.read(), /Canonical original gate/);
    await writeFile(resolve(f.payload, "gate.json"), f.gateBytes);
    f.bundle.proofs.push(f.bundle.proofs[0] as (typeof f.bundle.proofs)[number]);
    await writeFile(f.proofsPath, `${canonicalJson(f.bundle)}\n`);
    await assert.rejects(f.read(), /Exactly one integrated predecessor/);
    assert.equal(f.seen.length, 0);
  } finally {
    await f.close();
  }
});
