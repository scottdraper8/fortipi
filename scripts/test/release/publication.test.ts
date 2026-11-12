import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { repository } from "../../build-workspaces.ts";
import { pnpmExecutable } from "../../pnpm-executable.ts";
import {
  execute,
  publicationEnvironment,
  publicationHistory,
  publishPackages,
  verifyProvenance,
} from "../../prepare-release.ts";
import {
  githubRequest,
  object,
  REPOSITORY_ID,
  readJson,
  sha256,
} from "../../verify-release-gates.ts";
import { candidate, fixtureFiles, httpFixture, temporary } from "./fixtures.ts";

test("actual child observes durable intent before HTTP acceptance; lost availability reconciles without a second upload", async () => {
  const root = await temporary("fortipi-publication-");
  const c = candidate();
  await fixtureFiles(root, c);
  const journalPath = resolve(root, "journal.json");
  let uploads = 0;
  let available = false;
  let accepted: Buffer | undefined;
  const first = c.packages[0];
  assert.ok(first);
  const server = await httpFixture(async (request, response) => {
    if (request.method === "PUT") {
      uploads++;
      const journal = object(await readJson(journalPath));
      assert.ok(Array.isArray(journal.packages));
      assert.equal(object(journal.packages[0]).state, "upload-intent");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      accepted = Buffer.concat(chunks);
      assert.equal(sha256(accepted), first.sha256);
      response.statusCode = 202;
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://fixture");
    const name = decodeURIComponent(url.pathname.slice(1).split("/")[0] ?? "");
    const pkg = c.packages.find((p) => p.name === name);
    if (url.pathname.startsWith("/archive/")) {
      const p = c.packages.find((p) => p.sourceName === url.pathname.slice(9));
      assert.ok(p);
      response.end(await readFile(resolve(root, p.tarball)));
      return;
    }
    if (!pkg || (pkg === first && !available)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        dist: {
          integrity: pkg.integrity,
          tarball: `https://registry.npmjs.org/archive/${pkg.sourceName}`,
        },
      }),
    );
  });
  let starts = 0;
  const perform = async (pkg: typeof first) => {
    starts++;
    return execute(
      process.execPath,
      [
        resolve(repository, "scripts/test/release/publish-child.ts"),
        server.origin,
        journalPath,
        resolve(root, pkg.tarball),
        pkg.name,
      ],
      root,
      publicationEnvironment("synthetic-publication-role", resolve(root, "empty-auth")),
      15000,
    );
  };
  try {
    await writeFile(resolve(root, "empty-auth"), "", { flag: "wx", mode: 0o600 });
    await assert.rejects(
      publishPackages(c, sha256("candidate"), root, journalPath, perform, server.transport),
      /accepted but unavailable/,
    );
    assert.equal(starts, 1);
    assert.equal(uploads, 1);
    assert.ok(accepted);
    const journal = object(await readJson(journalPath));
    assert.ok(Array.isArray(journal.packages));
    assert.equal(object(journal.packages[0]).state, "accepted-but-unavailable");
    await assert.rejects(
      publishPackages(c, sha256("candidate"), root, journalPath, perform, server.transport),
      /Uncertain prior upload/,
    );
    assert.equal(starts, 1);
    assert.equal(uploads, 1);
    available = true;
    const reconciled = await publishPackages(
      c,
      sha256("candidate"),
      root,
      journalPath,
      perform,
      server.transport,
    );
    assert.ok(reconciled.packages.every((p) => p.state === "available"));
    assert.equal(starts, 1);
    assert.equal(uploads, 1);
    assert.equal(
      (await readFile(journalPath, "utf8")).includes("synthetic-publication-role"),
      false,
      "Journal must exclude child credentials/output",
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned pnpm consumes structured registry auth from a sterile environment; raw token configuration fails before transport", async () => {
  const root = await temporary("fortipi-pnpm-auth-");
  let requests = 0;
  const routes: string[] = [];
  let authorized = false;
  const token = "synthetic-local-token";
  const server = await httpFixture((request, response) => {
    requests++;
    routes.push(String(request.url));
    authorized = request.headers.authorization === `Bearer ${token}`;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name: "@fortipi-auth-check/example",
        "dist-tags": { latest: "0.0.0" },
        time: { "0.0.0": "2020-01-01T00:00:00.000Z" },
        versions: {
          "0.0.0": {
            name: "@fortipi-auth-check/example",
            version: "0.0.0",
            dist: {
              tarball: `${server.origin}/unused.tgz`,
              integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
            },
          },
        },
      }),
    );
  });
  try {
    const empty = resolve(root, "empty-auth");
    await writeFile(empty, "", { flag: "wx" });
    const env = publicationEnvironment(token, empty);
    const source = object(JSON.parse(String(env.pnpm_config__auth)));
    assert.deepEqual(Object.keys(source), ["https://registry.npmjs.org"]);
    env.pnpm_config__auth = JSON.stringify({
      [server.origin]: source["https://registry.npmjs.org"],
    });
    env.HOME = root;
    env.XDG_CONFIG_HOME = root;
    const pnpm = await pnpmExecutable();
    const args = [
      "--ignore-workspace",
      "--npmrc-auth-file",
      empty,
      "view",
      "@fortipi-auth-check/example",
      "version",
      "--json",
      "--registry",
      server.origin,
    ];
    const valid = await execute(pnpm, args, root, env, 30000);
    assert.equal(valid.code, 0, JSON.stringify({ stdout: valid.stdout, routes }));
    assert.equal(authorized, true);
    assert.equal(JSON.parse(valid.stdout), "0.0.0");
    assert.equal(requests, 1);
    const invalid = await execute(pnpm, args, root, { ...env, pnpm_config__auth: token }, 30000);
    assert.notEqual(invalid.code, 0);
    assert.equal(requests, 1, "Malformed raw token must not reach transport");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("post-npm verified bundle decoding binds every retained subject/source and keeps historical publisher attempts distinct", async () => {
  const root = await temporary("fortipi-provenance-");
  const c = candidate();
  try {
    // Synthetic certificate tests the post-verifier decoder only, never Sigstore trust or actual npm acceptance.
    const generated = await execute(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-config",
        "/dev/null",
        "-subj",
        "/CN=synthetic-test",
        "-addext",
        "subjectAltName=URI:https://github.com/scottdraper8/fortipi/.github/workflows/release.yml@refs/heads/main",
        "-keyout",
        resolve(root, "test-key.pem"),
        "-out",
        resolve(root, "certificate.pem"),
      ],
      root,
    );
    assert.equal(generated.code, 0);
    const { X509Certificate } = await import("node:crypto");
    const cert = new X509Certificate(await readFile(resolve(root, "certificate.pem")));
    const audit = {
      verified: c.packages.map((p, index) => ({
        name: p.name,
        version: p.version,
        attestationBundles: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(
                  JSON.stringify({
                    subject: [{ name: p.name, digest: { sha256: p.sha256 } }],
                    predicate: {
                      buildDefinition: {
                        externalParameters: {
                          workflow: {
                            repository: "https://github.com/scottdraper8/fortipi",
                            ref: "refs/heads/main",
                            path: ".github/workflows/release.yml",
                          },
                        },
                        resolvedDependencies: [{ digest: { gitCommit: c.sourceCommit } }],
                      },
                      runDetails: {
                        metadata: {
                          invocationId: `https://github.com/scottdraper8/fortipi/actions/runs/${index === 0 ? 8 : 9}/attempts/1`,
                        },
                      },
                    },
                  }),
                ).toString("base64"),
              },
              verificationMaterial: { certificate: { rawBytes: cert.raw.toString("base64") } },
            },
          },
        ],
      })),
    };
    const observed = verifyProvenance(audit, c);
    assert.deepEqual(
      observed.map((p) => p.runId),
      [8, 9, 9, 9, 9],
    );
    const bad = structuredClone(audit);
    const envelope = bad.verified[0]?.attestationBundles[0]?.bundle.dsseEnvelope;
    assert.ok(envelope);
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    statement.subject[0].digest.sha256 = sha256("another archive");
    envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    assert.throws(() => verifyProvenance(bad, c), /subject differs/);
    let started = false;
    const server = await httpFixture((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url?.includes("/jobs?")
            ? {
                total_count: 1,
                jobs: [
                  {
                    name: "publish",
                    started_at: started ? new Date().toISOString() : null,
                    conclusion: started ? "failure" : "skipped",
                  },
                ],
              }
            : {
                total_count: 1,
                workflow_runs: [
                  {
                    id: 8,
                    run_attempt: 1,
                    head_sha: c.sourceCommit,
                    repository: { id: REPOSITORY_ID },
                    head_repository: { id: REPOSITORY_ID },
                  },
                ],
              },
        ),
      );
    });
    try {
      assert.equal(await publicationHistory(c, githubRequest(undefined, server.transport)), null);
      started = true;
      assert.deepEqual(await publicationHistory(c, githubRequest(undefined, server.transport)), {
        runId: 8,
        runAttempt: 1,
      });
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
