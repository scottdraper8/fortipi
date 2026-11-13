// Synthetic API/credential fixtures over actual HTTP/files; never live access or Actions acceptance.
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { mock, test } from "node:test";
import {
  accessProducer,
  currentCloudflareResult,
  runAccessEvidence,
  writeAccessGate,
} from "../../access-evidence.ts";
import { repository } from "../../build-workspaces.ts";
import {
  checkCloudflareAccess,
  checkNpmAccess,
  cloudflareAccessChecks,
} from "../../check-access.ts";
import {
  canonicalJson,
  githubRequest,
  REPOSITORY,
  REPOSITORY_ID,
  readAccessGate,
  saveJson,
  sha256,
} from "../../verify-release-gates.ts";
import { candidate, directoryArchive, httpFixture, temporary } from "./fixtures.ts";

test("publication imports only its completed same-attempt CF job through actual digest-checked ZIP bytes", async () => {
  const root = await temporary("fortipi-access-current-zip-");
  const c = candidate();
  const candidateHash = sha256("current candidate protocol fixture");
  const directory = resolve(root, "cloudflare");
  const producer = { ...c.producer, workflowPath: ".github/workflows/access-preflight.yml" };
  const result = {
    schemaVersion: 1,
    kind: "cloudflare",
    checkedAt: new Date().toISOString(),
    checks: cloudflareAccessChecks,
    accountBindingSha256: sha256("bound account"),
  };
  await writeAccessGate(c, candidateHash, producer, directory, result);
  const zip = await directoryArchive(directory);
  const now = Date.now();
  const current = {
    producer,
    jobs: [
      {
        name: "cloudflare",
        status: "completed",
        conclusion: "success",
        started_at: new Date(now - 60000).toISOString(),
        completed_at: new Date(now).toISOString(),
      },
    ],
  };
  let foreign = false;
  const server = await httpFixture((request, response) => {
    if (request.url?.endsWith("/zip")) {
      response.writeHead(302, { location: "https://fixture.blob.core.windows.net/access.zip" });
      response.end();
    } else if (request.url === "/access.zip") response.end(zip.bytes);
    else {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name: `cloudflare-access-${c.sourceCommit}-${c.scope}-${producer.runId}-${producer.runAttempt}`,
          digest: `sha256:${sha256(zip.bytes)}`,
          expired: false,
          workflow_run: {
            id: foreign ? producer.runId + 1 : producer.runId,
            repository_id: REPOSITORY_ID,
            head_repository_id: REPOSITORY_ID,
            head_sha: c.sourceCommit,
            head_branch: "main",
          },
          created_at: new Date(now - 1).toISOString(),
          expires_at: new Date(now + 60000).toISOString(),
        }),
      );
    }
  });
  const environment = process.env;
  process.env = { FORTIPI_CF_ARTIFACT_ID: "71", FORTIPI_CF_ARTIFACT_DIGEST: sha256(zip.bytes) };
  try {
    assert.deepEqual(
      await currentCloudflareResult(
        c,
        candidateHash,
        current,
        directory,
        githubRequest(undefined, server.transport),
      ),
      result,
    );
    foreign = true;
    await assert.rejects(
      currentCloudflareResult(
        c,
        candidateHash,
        current,
        directory,
        githubRequest(undefined, server.transport),
      ),
    );
    foreign = false;
    const cfJob = current.jobs[0];
    assert.ok(cfJob);
    cfJob.conclusion = "failure";
    await assert.rejects(
      currentCloudflareResult(
        c,
        candidateHash,
        current,
        directory,
        githubRequest(undefined, server.transport),
      ),
    );
    cfJob.conclusion = "success";
    process.env.FORTIPI_CF_ARTIFACT_DIGEST = "0".repeat(64);
    await assert.rejects(
      currentCloudflareResult(
        c,
        candidateHash,
        current,
        directory,
        githubRequest(undefined, server.transport),
      ),
    );
  } finally {
    process.env = environment;
    await server.close();
    await zip.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("actual read checks create bounded CF/full payloads, preserve original CF time/bytes and omit private response values", async () => {
  const root = await temporary("fortipi-access-checks-");
  const c = candidate();
  const account = "1234567890abcdef".repeat(2);
  const cfToken = 'cf-fixture-quote"slash\\value';
  const npmToken = 'npm-fixture-quote"slash\\value';
  const username = "private-fixture-username";
  const paths: string[] = [];
  let denied = false;
  const server = await httpFixture(async (request, response) => {
    const path = request.url ?? "";
    paths.push(path);
    response.setHeader("content-type", "application/json");
    if (path === "/-/whoami") {
      assert.ok(
        request.headers.authorization === `Bearer ${npmToken}`,
        "Wrong synthetic credential",
      );
      response.end(JSON.stringify({ username }));
    } else {
      assert.ok(
        request.headers.authorization === `Bearer ${cfToken}`,
        "Wrong synthetic credential",
      );
      if (path === "/client/v4/graphql") {
        let body = "";
        for await (const part of request) body += part;
        const data = JSON.parse(body);
        assert.deepEqual(data.variables, { account });
        assert.equal(request.method, "POST");
        response.end(
          JSON.stringify({
            data: {
              viewer: {
                accounts: [
                  {
                    accountTag: account,
                    settings: Object.fromEntries(
                      [
                        "workersInvocationsAdaptive",
                        "durableObjectsInvocationsAdaptiveGroups",
                        "durableObjectsPeriodicGroups",
                      ].map((n) => [n, { enabled: true }]),
                    ),
                  },
                ],
              },
            },
            errors: null,
          }),
        );
      } else if (denied) {
        response.statusCode = 403;
        response.end(JSON.stringify({ errors: [{ message: cfToken }] }));
      } else
        response.end(
          JSON.stringify({
            success: true,
            result: path.endsWith("/workers/subdomain") ? { subdomain: "example" } : {},
          }),
        );
    }
  });
  const environment = process.env;
  process.env = {
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: cfToken,
    NPM_TOKEN: npmToken,
    NPM_SCOPE: c.scope,
  };
  const native = globalThis.fetch;
  const fetch = mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.ok(["api.cloudflare.com", "registry.npmjs.org"].includes(url.hostname));
      return native(`${server.origin}${url.pathname}${url.search}`, options);
    },
  );
  const output = mock.method(console, "log", () => {});
  try {
    const cf = await checkCloudflareAccess();
    const npm = await checkNpmAccess();
    assert.equal(cf.accountBindingSha256, sha256(account));
    assert.equal(paths.length, 6);
    const producer = { ...c.producer, workflowPath: ".github/workflows/access-preflight.yml" };
    const cfDirectory = resolve(root, "cf");
    const cfGate = await writeAccessGate(
      c,
      sha256("candidate protocol fixture"),
      producer,
      cfDirectory,
      cf,
    );
    const fullDirectory = resolve(root, "full");
    const fullGate = await writeAccessGate(
      c,
      cfGate.candidateSha256,
      producer,
      fullDirectory,
      cf,
      npm,
    );
    assert.equal(cfGate.kind, "cloudflare-access");
    assert.equal(fullGate.kind, "access");
    assert.equal(fullGate.checkedAt, cf.checkedAt);
    assert.equal(fullGate.claims.length, 2);
    assert.deepEqual(
      await readFile(resolve(cfDirectory, "cloudflare.json")),
      await readFile(resolve(fullDirectory, "cloudflare.json")),
    );
    await readAccessGate({ receipt: fullGate, directory: fullDirectory }, c);
    const bytes = await Promise.all(
      ["gate.json", "cloudflare.json", "npm.json"].map((p) =>
        readFile(resolve(fullDirectory, p), "utf8"),
      ),
    );
    const publicOutput =
      output.mock.calls.flatMap((call) => call.arguments).join("\n") + bytes.join("\n");
    for (const forbidden of [
      account,
      cfToken,
      npmToken,
      username,
      JSON.stringify(cfToken).slice(1, -1),
      JSON.stringify(npmToken).slice(1, -1),
    ])
      assert.equal(publicOutput.includes(forbidden), false, "Private fixture material escaped");
    await assert.rejects(
      writeAccessGate(c, cfGate.candidateSha256, producer, resolve(root, "wrong-scope"), cf, {
        ...npm,
        scope: "foreign-scope",
      }),
      /npm scope/,
    );
    await assert.rejects(
      writeAccessGate(c, cfGate.candidateSha256, producer, resolve(root, "extra"), {
        ...cf,
        secret: cfToken,
      }),
      /Unexpected receipt field/,
    );
    denied = true;
    await assert.rejects(checkCloudflareAccess(), /Account access: HTTP 403/);
  } finally {
    output.mock.restore();
    fetch.mock.restore();
    process.env = environment;
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("current access writer requires the exact executing workflow/job/attempt and never self-asserts completed success", async () => {
  const c = candidate();
  const environment = process.env;
  process.env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
    GITHUB_SHA: c.sourceCommit,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/access-preflight.yml@refs/heads/main`,
    GITHUB_JOB: "cloudflare",
    GITHUB_RUN_ID: "50",
    GITHUB_RUN_ATTEMPT: "2",
  };
  let fault: "source" | "attempt" | "completed" | null = null;
  const server = await httpFixture((request, response) => {
    let value: unknown;
    if (request.url?.includes("/actions/workflows/"))
      value = { id: 4, path: ".github/workflows/access-preflight.yml", state: "active" };
    else if (request.url?.includes("/jobs?"))
      value = { total_count: 1, jobs: [{ name: "cloudflare", status: "in_progress" }] };
    else
      value = {
        id: 50,
        run_attempt: fault === "attempt" ? 3 : 2,
        workflow_id: 4,
        head_sha: fault === "source" ? "b".repeat(40) : c.sourceCommit,
        head_branch: "main",
        event: "workflow_dispatch",
        path: ".github/workflows/access-preflight.yml",
        repository: { id: REPOSITORY_ID },
        head_repository: { id: REPOSITORY_ID },
        status: fault === "completed" ? "completed" : "in_progress",
        conclusion: fault === "completed" ? "success" : null,
      };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  });
  try {
    const current = await accessProducer(
      c,
      "deployment",
      githubRequest(undefined, server.transport),
    );
    assert.equal(current.producer.runId, 50);
    assert.equal(
      current.producer.workflowSha256,
      sha256(await readFile(resolve(repository, ".github/workflows/access-preflight.yml"))),
    );
    for (const f of ["source", "attempt", "completed"] as const) {
      fault = f;
      await assert.rejects(
        accessProducer(c, "deployment", githubRequest(undefined, server.transport)),
      );
    }
    fault = null;
    process.env.GITHUB_JOB = "npm";
    await assert.rejects(
      accessProducer(c, "deployment", githubRequest(undefined, server.transport)),
    );
    process.env.GITHUB_JOB = "other";
    await assert.rejects(
      accessProducer(c, "publication", githubRequest(undefined, server.transport)),
    );
  } finally {
    process.env = environment;
    await server.close();
  }
});

test("missing or wrong original candidate binding refuses before any CF/npm credential access", async () => {
  const root = await temporary("fortipi-access-prekeys-");
  const path = resolve(root, "candidate.json");
  await saveJson(path, candidate());
  const environment = process.env;
  let keys = 0;
  const values: NodeJS.ProcessEnv = { GITHUB_ACTIONS: "true" };
  process.env = new Proxy(values, {
    get(target, key: string) {
      if (["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "NPM_TOKEN"].includes(key)) {
        keys++;
        throw new Error("Forbidden credential access");
      }
      return target[key];
    },
  });
  try {
    await assert.rejects(
      runAccessEvidence("cloudflare", path, "deployment", resolve(root, "cf")),
      /ArtifactReference/,
    );
    values.FORTIPI_CANDIDATE_REFERENCE = canonicalJson({
      candidateSha256: sha256("wrong original candidate"),
    });
    await assert.rejects(
      runAccessEvidence("publication", path, "publication", resolve(root, "publication"), root),
      /Retained candidate hash mismatch/,
    );
    assert.equal(keys, 0);
  } finally {
    process.env = environment;
    await rm(root, { recursive: true, force: true });
  }
});
