// Provider setup adapted from the existing coordinator fixture. HTTP/ZIP lineage facts
// and provider effects are synthetic; package/prepare/history/file operations are real.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { extract } from "tar";
import type {
  ApplicationRecoveryAfter,
  ApplicationRecoveryBefore,
  ConfirmedPlatformRecovery,
} from "../../../tests/clients/platform-recovery.ts";
import { repository } from "../../build-workspaces.ts";
import { observeDeployment, type TargetDescriptor } from "../../deploy-smoke.ts";
import { generateNotices } from "../../generate-notices.ts";
import type { RecoveryInput, RecoveryPorts } from "../../platform-recovery.ts";
import * as prepare from "../../prepare-release.ts";
import { childEnvironment, execute, generateSbom, stageAndPack } from "../../prepare-release.ts";
import {
  type ArtifactReference,
  type CandidateManifest,
  canonicalJson,
  type DeploymentIdentity,
  type GateReceipt,
  integratedClaims,
  inventory,
  object,
  REPOSITORY,
  REPOSITORY_ID,
  readJson,
  regularBytes,
  saveJson,
  sha256,
  verifyPayload,
} from "../../verify-release-gates.ts";
import { candidate, directoryArchive, discard, httpFixture, temporary } from "./fixtures.ts";

const v0 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const v1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const other = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const d0 = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const d1 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const admin = "synthetic-application-only";
let root: string;
let prepared: string;
let manifestPath: string;
let manifestHash: string;
let sourceCommit: string;
let target: TargetDescriptor;
let config: Record<string, unknown>;
let preparedReceipt: Record<string, unknown>;
let nextOperation = 0;
let retainedCandidate: CandidateManifest;

async function preparePackages() {
  root = await temporary("fortipi-recovery-protocol-");
  const directory = resolve(root, "candidate");
  await mkdir(directory);
  const c = candidate(); // API identity only is synthetic; all five package archives below are actual.
  const packed = await stageAndPack(repository, resolve(directory, "packs"), c.scope, c.version);
  await generateSbom(repository, directory, c.scope, c.version, await generateNotices());
  await mkdir(resolve(directory, "image"));
  for (const name of ["image-metadata.json", "sources-and-notices.tar"])
    await copyFile(
      resolve(repository, "apps/worker/dist/container", name),
      resolve(directory, "image", name),
      1,
    );
  const assets = object(
    await readJson(resolve(repository, "packages/fortipi-cli/worker-assets/asset-manifest.json")),
  );
  c.sourceCommit = String(assets.sourceCommit);
  c.assetManifestSha256 = packed.assetManifestSha256;
  const image = object(await readJson(resolve(directory, "image/image-metadata.json")));
  c.image = {
    sourceCommit: String(image.sourceCommit),
    metadataSha256: sha256(await regularBytes(resolve(directory, "image/image-metadata.json"))),
    imageId: String(image.imageId),
    builtManifestDigest: String(image.builtManifestDigest),
    sourceKitSha256: String(image.sourceKitSha256),
  };
  c.packages = packed.packages;
  c.files = await inventory(directory);
  manifestPath = resolve(directory, "candidate.json");
  await saveJson(manifestPath, c);
  manifestHash = sha256(await regularBytes(manifestPath));
  sourceCommit = c.sourceCommit;
  retainedCandidate = c;
  const operator = await readJson(
    resolve(repository, "packages/fortipi-cli/templates/operator-config.example.json"),
  );
  target = {
    schemaVersion: 1,
    backend: "free",
    accountBindingSha256: sha256("a".repeat(32)),
    operator,
  };
  prepared = resolve(root, "prepared");
  const result = await execute(
    process.execPath,
    [
      resolve(repository, "packages/fortipi-cli/dist/bin.js"),
      "prepare",
      "--config",
      resolve(repository, "packages/fortipi-cli/templates/operator-config.example.json"),
      "--directory",
      prepared,
      "--non-interactive",
      "--json",
    ],
    root,
    childEnvironment(),
    120000,
  );
  assert.equal(result.code, 0);
  preparedReceipt = object(JSON.parse(result.stdout));
  config = object(await readJson(resolve(prepared, "wrangler.json")));
}

async function fixture(fault = "") {
  const operationId = (++nextOperation).toString(16).padStart(32, "0");
  const evidenceRoot = resolve(root, operationId);
  const journalDirectory = resolve(evidenceRoot, "provider-recovery");
  const runtime = object(object(target.operator).runtime);
  const durable = object(config.durable_objects).bindings;
  assert.ok(Array.isArray(durable));
  let ids = [v0];
  let active = v0;
  let deploymentId = d0;
  let annotation = "";
  let unavailable = false;
  const calls: string[][] = [];
  const server = await httpFixture((request, response) => {
    assert.equal(
      request.headers.authorization,
      request.url === "/health" ? undefined : `Bearer ${admin}`,
    );
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/health" ? { status: "ok", protocolVersion: "1.0" } : runtime,
      ),
    );
  });
  const read: RecoveryPorts["read"] = async (path) => {
    if (unavailable) throw new Error("synthetic-provider-secret-do-not-retain");
    if (path === "/workers/subdomain") return { subdomain: "example" };
    if (path.endsWith("/subdomain")) return { enabled: true };
    if (path.endsWith("/deployments"))
      return {
        deployments: [
          {
            id: deploymentId,
            strategy: "percentage",
            versions: [{ version_id: active, percentage: 100 }],
          },
        ],
      };
    if (path.endsWith("/versions?per_page=100")) return { items: ids.map((id) => ({ id })) };
    if (path === "/workers/durable_objects/namespaces?page=1&per_page=1000")
      return durable.map((raw, i) => ({
        class: object(raw).class_name,
        script: object(object(target.operator).deployment).name,
        id: sha256(
          `namespace-${i}${fault === "namespace" && ids.length > 1 ? "-replacement" : ""}`,
        ),
        use_sqlite: true,
      }));
    const id = path.split("/").at(-1);
    assert.ok(id === v0 || id === v1 || id === other);
    const changed = id === v1;
    const migrations = config.migrations;
    assert.ok(Array.isArray(migrations));
    return {
      id,
      annotations: { "workers/tag": annotation },
      resources: {
        script: {
          etag: changed && fault === "bytes" ? "different-modules" : "same-provider-module-hash",
          named_handlers: ["ControlPlane", "AgentSession", "WorkspaceObject", "WorkspaceProxy"].map(
            (name) => ({ name, handlers: ["fetch"] }),
          ),
        },
        script_runtime: {
          compatibility_date: config.compatibility_date,
          compatibility_flags: config.compatibility_flags,
          migration_tag: object(migrations.at(-1)).tag,
          exports: Object.fromEntries(
            durable.map((raw) => [
              String(object(raw).class_name),
              {
                type: "durable-object",
                storage: "sqlite",
                ...(changed ? { state: "created" } : {}),
              },
            ]),
          ),
        },
        bindings: [
          ...durable.map((raw) => ({ type: "durable_object_namespace", ...object(raw) })),
          { type: "ai", name: "AI" },
          { type: "json", name: "FORTIPI_CONFIG", json: runtime },
          ...(changed && fault === "secret"
            ? []
            : [{ type: "secret_text", name: "FORTIPI_ADMIN_TOKEN" }]),
          ...(changed && fault === "binding"
            ? [{ type: "kv_namespace", name: "OTHER", namespace_id: "unrelated" }]
            : []),
        ],
      },
    };
  };
  const beforeIdentity = await observeDeployment(
    retainedCandidate,
    manifestHash,
    target,
    prepared,
    {
      workerName: object(object(target.operator).deployment).name,
      origin: object(object(target.operator).deployment).origin,
      targets: [object(object(target.operator).deployment).origin],
      workerVersionId: v0,
      sourceCommit,
      packageVersion: "0.1.0",
      assetManifestSha256: preparedReceipt.assetManifestSha256,
      configSha256: preparedReceipt.configSha256,
    },
    read,
    server.transport,
    admin,
  );
  const checkpointDirectory = resolve(evidenceRoot, "application-recovery");
  const beforePath = resolve(checkpointDirectory, "application-before.json");
  // Synthetic public canary DTOs qualify only this local coordinator protocol.
  const targetBackend = {
    kind: "executor" as const,
    executorId: "offline-executor",
    generation: 1,
  };
  const publicBefore: ApplicationRecoveryBefore = {
    schemaVersion: 1,
    candidateSha256: manifestHash,
    sourceCommit,
    deploymentId: d0,
    workerVersionId: v0,
    capturedAt: new Date().toISOString(),
    agentId: "original-agent",
    conversationId: "original-conversation",
    requestId: "original-request",
    jobId: "original-job",
    admission: {
      operationId: "send-operation",
      taskId: "original-task",
      messageId: "original-message",
      revision: "r1",
      eventSeq: 1,
    },
    approval: {
      approvalId: "original-approval",
      jobId: "original-job",
      agentId: "original-agent",
      conversationId: "original-conversation",
      requestingPrincipalId: "original-principal",
      version: 1,
      state: "pending",
      operation: {
        operationId: "dispatch-operation",
        operationDigest: sha256("dispatch"),
        tool: "shell",
        arguments: { command: "echo seed1010-recovery-no-start" },
        workspaceId: "original-workspace",
        baseRevision: "r1",
        target: targetBackend,
        trust: "host",
        capabilities: ["shell"],
        policyVersion: 1,
        grantVersion: 1,
        expiresAt: Date.now() + 600_000,
      },
    },
    target: targetBackend,
    eventThrough: 1,
    eventPrefixSha256: sha256("retained-event-prefix"),
    snapshotSha256: sha256("snapshot"),
    workspace: {
      binding: {
        workspaceId: "original-workspace",
        bindingVersion: 1,
        revision: "r1",
        manifestHash: sha256("manifest"),
        config: { kind: "computer" },
        availability: "available",
      },
      files: [{ path: "canary.txt", size: 6, sha256: sha256("canary") }],
    },
  };
  await saveJson(beforePath, publicBefore);
  const beforeBytes = await regularBytes(beforePath);
  const input: RecoveryInput = {
    candidatePath: manifestPath,
    candidateSha256: manifestHash,
    sourceCommit,
    preparedDirectory: prepared,
    target,
    before: beforeIdentity,
    operationId,
    journalDirectory,
    checkpointDirectory,
    beforeCheckpoint: {
      path: beforePath,
      size: beforeBytes.length,
      mode: 0o600,
      sha256: sha256(beforeBytes),
    },
  };
  const ports: RecoveryPorts = {
    read,
    applicationTransport: server.transport,
    applicationAdminToken: admin,
    wrangler: {
      async run(request) {
        // Both write intents must be real, durable and exclusive before entering this effect port.
        const intent = object(await readJson(resolve(input.journalDirectory, "intent.json")));
        const operationId = String(intent.operationId);
        assert.equal(intent.candidateSha256, manifestHash);
        assert.equal(intent.beforeCheckpointSha256, input.beforeCheckpoint.sha256);
        const upload = request.args[1] === "upload";
        await regularBytes(
          resolve(
            input.journalDirectory,
            upload ? "upload-attempt.json" : "deployment-attempt.json",
          ),
        );
        assert.equal(request.cwd, prepared);
        assert.equal(request.deploymentAuth, true);
        assert.equal(request.input, undefined);
        assert.equal(request.outputFile, undefined);
        calls.push(request.args);
        if (upload) {
          assert.deepEqual(request.args, [
            "versions",
            "upload",
            "--config",
            resolve(prepared, "wrangler.json"),
            "--tag",
            `fortipi-recovery-${operationId}`,
          ]);
          annotation = `fortipi-recovery-${operationId}`;
          if (fault !== "same" && fault !== "upload-absent")
            ids = [v1, ...(fault === "latest" ? [other] : []), v0];
          if (fault === "ambiguous-upload") {
            unavailable = true;
            throw new Error("synthetic-runner-secret-do-not-retain");
          }
          if (fault === "upload-absent") throw new Error("uncertain-not-observed");
        } else {
          assert.deepEqual(request.args, [
            "versions",
            "deploy",
            `${v1}@100%`,
            "--config",
            resolve(prepared, "wrangler.json"),
            "--durable-objects-code-update-mode",
            "immediate",
            "--yes",
          ]);
          active = v1;
          deploymentId = d1;
          if (fault === "ambiguous-deploy") {
            unavailable = true;
            throw new Error("synthetic-runner-secret-do-not-retain");
          }
        }
        return "synthetic-untrusted-stdout-do-not-retain";
      },
    },
  };
  return {
    input,
    ports,
    publicBefore,
    evidenceRoot,
    calls,
    close: server.close,
    reconnect() {
      unavailable = false;
    },
    unrelated() {
      ids.unshift(other);
    },
    wrongActive() {
      active = v0;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function afterFile(f: Fixture, operation: ConfirmedPlatformRecovery) {
  const value: ApplicationRecoveryAfter = {
    schemaVersion: 1,
    candidateSha256: manifestHash,
    sourceCommit,
    beforeCheckpointSha256: f.input.beforeCheckpoint.sha256,
    workerVersionId: operation.after.workerVersionId,
    originalTaskId: f.publicBefore.admission.taskId,
    originalJobId: f.publicBefore.jobId,
    originalReceiptRetained: true,
    originalEventPrefixSha256: f.publicBefore.eventPrefixSha256,
    actualWorkspaceHashes: f.publicBefore.workspace.files,
    continuation: "public-approval-rejection",
    taskState: "completed",
    executionIdentityAbsentBeforeAndAfter: true,
    checkedAt: new Date().toISOString(),
  };
  const path = resolve(f.input.checkpointDirectory, "application-after.json");
  await saveJson(path, value);
  const bytes = await regularBytes(path);
  return { path, size: bytes.length, mode: 0o600, sha256: sha256(bytes) };
}

/** Controlled source protocol check. Candidate authentication and the full live
 * child are substituted at their already separate boundaries. Actual outer
 * guards, installed hashes/pins, provider helpers, histories and ZIP reader run.
 * No real Actions, Cloudflare operation or public continuation is claimed. */
async function controlled() {
  const nativeFetch = fetch;
  const ordinaryEnvironment = process.env;
  let closeFixture: (() => Promise<void>) | undefined;
  let originalZip: Awaited<ReturnType<typeof directoryArchive>> | undefined;
  let integratedZip: Awaited<ReturnType<typeof directoryArchive>> | undefined;
  const assertMethods = new Map<string, unknown>();
  try {
    await preparePackages();
    const f = await fixture();
    closeFixture = f.close;
    const c = retainedCandidate;
    const consumer = resolve(root, "consumer");
    const cliRoot = resolve(consumer, "node_modules", `@${c.scope}/fortipi-cli`);
    await mkdir(cliRoot, { recursive: true });
    const cliPackage = c.packages.find((row) => row.sourceName === "fortipi-cli");
    assert.ok(cliPackage);
    await extract({
      file: resolve(dirname(manifestPath), cliPackage.tarball),
      cwd: cliRoot,
      strip: 1,
    });
    const contractPackage = c.packages.find((row) => row.sourceName === "fortipi-contract");
    assert.ok(contractPackage);
    const contractRoot = resolve(consumer, "node_modules", `@${c.scope}/fortipi-contract`);
    await mkdir(contractRoot, { recursive: true });
    await extract({
      file: resolve(dirname(manifestPath), contractPackage.tarball),
      cwd: contractRoot,
      strip: 1,
    });
    async function protect(path: string): Promise<void> {
      const stat = await lstat(path);
      assert.ok(!stat.isSymbolicLink());
      if (stat.isDirectory()) {
        for (const name of await readdir(path)) await protect(resolve(path, name));
        await chmod(path, 0o555);
      } else await chmod(path, stat.mode & 0o111 ? 0o555 : 0o444);
    }
    await protect(resolve(consumer, "node_modules"));
    const installedWranglerUrl = pathToFileURL(resolve(cliRoot, "dist/wrangler.js"));
    const actualWrangler = await import(installedWranglerUrl.href);
    mock.module(installedWranglerUrl, {
      cache: true,
      exports: { ...actualWrangler, wrangler: f.ports.wrangler },
    });
    const installationPath = resolve(root, "installation.json");
    await saveJson(installationPath, {
      schemaVersion: 1,
      consumer: await realpath(consumer),
      prepared,
      target,
      candidatePath: manifestPath,
      candidateSha256: manifestHash,
      cliBin: resolve(cliRoot, "dist/bin.js"),
    });
    const deploymentPath = resolve(root, "deployment.json");
    await saveJson(deploymentPath, f.input.before);
    const cli = {
      workerName: f.input.before.workerName,
      origin: f.input.before.origin,
      targets: [f.input.before.origin],
      workerVersionId: v0,
      sourceCommit,
      packageVersion: c.version,
      assetManifestSha256: c.assetManifestSha256,
      configSha256: preparedReceipt.configSha256,
    };
    await saveJson(`${deploymentPath}.cli.json`, cli);
    const originalBytes = await readFile(deploymentPath);
    const originalCli = await readFile(`${deploymentPath}.cli.json`);
    const workflow = await readFile(resolve(repository, ".github/workflows/deploy.yml"));
    const ciWorkflow = await readFile(resolve(repository, ".github/workflows/ci.yml"));
    const proofsPath = resolve(root, "proofs.json");
    // Synthetic completed CI facts exercise the real producer/ZIP reader. They
    // deliberately do not satisfy the separate detailed infrastructure oracle.
    const integratedDirectory = resolve(root, "proofs/integrated/payload");
    for (const id of integratedClaims)
      await saveJson(resolve(integratedDirectory, `claims/${id}.json`), {
        id,
        outcome: "pass",
        identity: { sourceCommit, candidateSha256: manifestHash },
        observation: { fixture: "outer source protocol only" },
      });
    const integratedFiles = await inventory(integratedDirectory);
    const integratedGate: GateReceipt = {
      schemaVersion: 1,
      kind: "integrated",
      candidateSha256: manifestHash,
      sourceCommit,
      scope: c.scope,
      checkedAt: new Date().toISOString(),
      producer: {
        workflowPath: ".github/workflows/ci.yml",
        workflowSha256: sha256(ciWorkflow),
        workflowId: 11,
        runId: 61,
        runAttempt: 1,
      },
      platforms: [],
      deployments: [],
      files: integratedFiles,
      claims: integratedClaims.map((id) => {
        const result = integratedFiles.find((file) => file.path === `claims/${id}.json`);
        assert.ok(result);
        return { id, outcome: "pass", result };
      }),
    };
    await saveJson(resolve(integratedDirectory, "gate.json"), integratedGate);
    integratedZip = await directoryArchive(integratedDirectory);
    const integratedReference: ArtifactReference = {
      runId: 61,
      runAttempt: 1,
      artifactId: 63,
      artifactName: `integrated-${sourceCommit}-${c.scope}-61-1`,
      artifactDigest: `sha256:${sha256(integratedZip.bytes)}`,
      candidateSha256: manifestHash,
    };
    await saveJson(proofsPath, {
      schemaVersion: 1,
      candidateArtifact: integratedReference,
      proofs: [{ artifact: integratedReference, directory: integratedDirectory }],
    });
    let integratedDownloads = 0;
    let originalReference: ArtifactReference | undefined;
    let childCalls = 0;
    let childMode = "normal";
    let copiedRecords: string[] = [];
    let privateRecords: string[] = [];
    let cloudReads = 0;
    let authorityFault = "";
    let credentialReads = 0;
    const secrets = new Set([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "FORTIPI_ADMIN_TOKEN",
    ]);
    const frame = {
      GITHUB_ACTIONS: "true",
      GITHUB_TOKEN: "",
      NPM_TOKEN: "",
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_SHA: sourceCommit,
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/deploy.yml@refs/heads/main`,
      GITHUB_JOB: "operate",
      GITHUB_RUN_ID: "91",
      GITHUB_RUN_ATTEMPT: "1",
      OPERATION: "deploy",
      SOURCE_SHA: sourceCommit,
      EXPECTED_TAG: c.tag,
      RELEASE_VERSION: c.version,
      RELEASE_SCOPE: c.scope,
      CONFIRM: `deploy ${c.tag} ${sourceCommit} ${c.scope}`,
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "synthetic-cf-only",
      FORTIPI_ADMIN_TOKEN: admin,
    };
    Object.assign(process.env, frame);
    process.env = new Proxy(ordinaryEnvironment, {
      get(value, key) {
        if (typeof key === "string" && secrets.has(key)) credentialReads++;
        return Reflect.get(value, key);
      },
      set(value, key, next) {
        value[String(key)] = String(next);
        return true;
      },
    });
    globalThis.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") return nativeFetch(input, options);
      if (url.hostname === "api.cloudflare.com") {
        cloudReads++;
        assert.equal(
          new Headers(options?.headers).get("authorization"),
          "Bearer synthetic-cf-only",
        );
        assert.equal(options?.method ?? "GET", "GET");
        const path = url.pathname.replace(`/client/v4/accounts/${"a".repeat(32)}`, "") + url.search;
        return Response.json({ success: true, result: await f.ports.read(path) });
      }
      if (url.hostname.endsWith(".workers.dev"))
        return f.ports.applicationTransport(input, options);
      if (url.hostname === "fixture.blob.core.windows.net") {
        if (url.pathname === "/integrated.zip") {
          assert.ok(integratedZip);
          assert.ok(!new Headers(options?.headers).has("authorization"));
          integratedDownloads++;
          return new Response(Uint8Array.from(integratedZip.bytes));
        }
        assert.ok(originalZip);
        return new Response(Uint8Array.from(originalZip.bytes));
      }
      assert.equal(url.hostname, "api.github.com");
      const path = url.pathname + url.search;
      const now = Date.now();
      const base = `/repos/${REPOSITORY}`;
      const original =
        path.includes("/runs/81") ||
        path.includes("/workflows/71") ||
        path.includes("/artifacts/83");
      const integrated =
        path.includes("/runs/61") ||
        path.includes("/artifacts/63") ||
        path.includes("/workflows/11") ||
        path.includes("/.github/workflows/ci.yml");
      const historical = original || integrated;
      const runId = integrated ? 61 : original ? 81 : 91;
      const producerId = integrated ? 11 : original ? 71 : 21;
      if (path.endsWith("/zip"))
        return Response.redirect(
          `https://fixture.blob.core.windows.net/${integrated ? "integrated" : "original"}.zip`,
          302,
        );
      if (path === base) return Response.json({ id: REPOSITORY_ID, full_name: REPOSITORY });
      if (path.endsWith("/git/ref/heads/main"))
        return Response.json({ object: { sha: sourceCommit } });
      if (path.includes("/git/matching-refs/")) return Response.json([]);
      if (path.includes("/contents/"))
        return Response.json({
          encoding: "base64",
          content: (integrated ? ciWorkflow : workflow).toString("base64"),
        });
      if (path.includes("/actions/workflows/"))
        return Response.json({
          id: producerId,
          path: integrated ? ".github/workflows/ci.yml" : ".github/workflows/deploy.yml",
          state: "active",
        });
      if (path.includes("/jobs?"))
        return Response.json({
          total_count: 1,
          jobs: [
            {
              id: 101,
              run_id: runId,
              head_sha: sourceCommit,
              name: integrated ? "policy-and-integration" : "operate",
              status: historical
                ? "completed"
                : authorityFault === "failed-job"
                  ? "completed"
                  : "in_progress",
              conclusion: historical ? "success" : null,
              started_at: new Date(now - 5000).toISOString(),
              completed_at: new Date(now - 1000).toISOString(),
            },
          ],
        });
      if (path.endsWith("/actions/artifacts/83")) {
        assert.ok(originalReference);
        return Response.json({
          id: 83,
          name: originalReference.artifactName,
          digest: originalReference.artifactDigest,
          expired: false,
          created_at: new Date(now - 2000).toISOString(),
          expires_at: new Date(now + 60000).toISOString(),
          workflow_run: {
            id: 81,
            repository_id: REPOSITORY_ID,
            head_repository_id: REPOSITORY_ID,
            head_sha: sourceCommit,
            head_branch: "main",
          },
        });
      }
      if (path.endsWith("/actions/artifacts/63"))
        return Response.json({
          id: 63,
          name: integratedReference.artifactName,
          digest: integratedReference.artifactDigest,
          expired: false,
          created_at: new Date(now - 2000).toISOString(),
          expires_at: new Date(now + 60000).toISOString(),
          workflow_run: {
            id: 61,
            repository_id: REPOSITORY_ID,
            head_repository_id: REPOSITORY_ID,
            head_sha: sourceCommit,
            head_branch: "main",
          },
        });
      assert.ok(path.includes("/actions/runs/"), "Unexpected controlled API route");
      return Response.json({
        id: runId,
        workflow_id: producerId,
        run_attempt: authorityFault === "superseded" ? 2 : 1,
        head_sha:
          integrated && authorityFault === "integrated-source" ? "f".repeat(40) : sourceCommit,
        head_branch: "main",
        event: integrated ? "push" : "workflow_dispatch",
        status: historical ? "completed" : "in_progress",
        conclusion: historical ? "success" : null,
        repository: { id: REPOSITORY_ID },
        head_repository: { id: REPOSITORY_ID },
        path: integrated ? ".github/workflows/ci.yml" : ".github/workflows/deploy.yml",
        run_started_at: new Date(now - 10000).toISOString(),
        updated_at: new Date(now - 1000).toISOString(),
      });
    };
    const evidence: typeof prepare.runEvidence = async (
      mode,
      candidatePath,
      fixturePath,
      out,
      deployment,
      recovery,
    ) => {
      childCalls++;
      assert.equal(mode, "live");
      assert.equal(candidatePath, manifestPath);
      assert.equal(fixturePath, resolve(repository, "tests/clients/fixtures/local.json"));
      assert.ok(deployment && recovery);
      await mkdir(out, { mode: 0o700 });
      const startup = await readJson(deployment);
      if (recovery.coordinator.mode === "perform" && childMode === "normal") {
        await mkdir(recovery.checkpointDirectory, { mode: 0o700 });
        const beforePath = resolve(recovery.checkpointDirectory, "application-before.json");
        await saveJson(beforePath, f.publicBefore);
        const bytes = await regularBytes(beforePath);
        const before = { path: beforePath, size: bytes.length, mode: 0o600, sha256: sha256(bytes) };
        f.input.journalDirectory = resolve(out, "provider-recovery");
        f.input.beforeCheckpoint = before;
        const result = await recovery.coordinator.bridge.perform(before);
        assert.equal(result.status, "operation-confirmed");
        if (result.status !== "operation-confirmed") throw Error("Controlled perform unavailable");
        f.input.checkpointDirectory = recovery.checkpointDirectory;
        f.input.beforeCheckpoint = before;
        const after = await afterFile(f, result);
        assert.equal((await recovery.coordinator.bridge.finish(after)).status, "qualified");
        assert.deepEqual(startup, f.input.before);
      } else if (recovery.coordinator.mode === "verify-existing") {
        const result = await recovery.coordinator.bridge.verifyExisting();
        assert.equal(result.status, "lineage-confirmed");
        if (result.status !== "lineage-confirmed") throw Error("Controlled original unavailable");
        assert.deepEqual(startup, result.current, "Child must receive the exact fresh timestamp");
        copiedRecords = [result.before.path, result.after.path];
        assert.deepEqual(
          copiedRecords,
          [
            resolve(recovery.checkpointDirectory, "application-before.json"),
            resolve(recovery.checkpointDirectory, "application-after.json"),
          ],
          "Exact ec6 child path contract before any public read",
        );
        // This in-process observer sees the frozen parent cache before IPC serialization.
        assert.ok(
          Object.isFrozen(result) &&
            Object.isFrozen(result.before) &&
            Object.isFrozen(result.after),
        );
        for (const [index, record] of [result.before, result.after].entries()) {
          const bytes = await regularBytes(record.path);
          const original = await regularBytes(
            resolve(
              root,
              "proofs/original/payload/claims/application-recovery",
              index === 0 ? "application-before.json" : "application-after.json",
            ),
          );
          assert.deepEqual(bytes, original);
          assert.equal(bytes.length, record.size);
          assert.equal(sha256(bytes), record.sha256);
          assert.equal((await lstat(record.path)).mode & 0o777, record.mode);
          assert.equal(record.mode, 0o600);
        }
      }
      const files = await inventory(out);
      const result = files[0];
      assert.ok(result || childMode === "omit-phases");
      // Synthetic child metadata only, used solely to observe inventory timing.
      const gate = {
        schemaVersion: 1,
        kind: "live",
        candidateSha256: manifestHash,
        sourceCommit,
        scope: c.scope,
        producer: await prepare.evidenceProducer(repository, c, "live"),
        checkedAt: new Date().toISOString(),
        deployments: [startup],
        files,
        claims: result ? [{ id: "platform-recovery", outcome: "pass", result }] : [],
        platforms: [],
      };
      await saveJson(resolve(out, "gate.json"), gate);
      if (childMode === "tamper-local")
        await writeFile(
          resolve(integratedDirectory, "claims/infrastructure-boundaries.json"),
          `${canonicalJson({ id: "infrastructure-boundaries", outcome: "pass", observation: { substituted: true } })}\n`,
        );
    };
    mock.module(new URL("../../prepare-release.ts", import.meta.url), {
      cache: true,
      exports: {
        ...prepare,
        runEvidence: evidence,
        loadWorkflowCandidate: async (path: string) => {
          assert.equal(path, manifestPath);
          return { candidate: c, hash: manifestHash, directory: dirname(manifestPath) };
        },
      },
    });
    const readerUrl = new URL("../../application-recovery-existing.ts", import.meta.url);
    const originalReader = (await import(
      readerUrl.href
    )) as typeof import("../../application-recovery-existing.ts");
    mock.module(readerUrl, {
      cache: true,
      exports: {
        ...originalReader,
        createExistingApplicationRecoveryCoordinator(
          ...args: Parameters<typeof originalReader.createExistingApplicationRecoveryCoordinator>
        ) {
          const reader = originalReader.createExistingApplicationRecoveryCoordinator(...args);
          return {
            ...reader,
            async verifyExisting() {
              const result = await reader.verifyExisting();
              if (result.status === "lineage-confirmed")
                privateRecords = [result.before.path, result.after.path];
              return result;
            },
          };
        },
      },
    });
    const { runLiveRecoveryEvidence } = await import("../../live-recovery-evidence.ts");
    // The outer privacy boundary intentionally hides causes. In this controlled
    // subprocess, retain only assertion method + allowlisted source locations.
    const failures: { method: string; frames: string[] }[] = [];
    for (const method of ["equal", "deepEqual", "ok"] as const) {
      const original = assert[method];
      assertMethods.set(method, original);
      // Do not use mock.method here: its call history retains every assertion
      // argument, including large package buffers from this controlled setup.
      Reflect.set(assert, method, (...args: unknown[]) => {
        try {
          return Reflect.apply(original, assert, args);
        } catch (error) {
          const frames = [
            ...(new Error().stack ?? "").matchAll(
              /\/(?:verify-release-gates|application-recovery-existing|live-recovery-evidence|application-recovery-checkpoints|platform-recovery|live-infrastructure-local)\.ts:\d+:\d+/g,
            ),
          ]
            .map((match) => match[0].slice(1))
            .slice(0, 4);
          failures.push({ method, frames });
          if (failures.length > 4) failures.shift();
          throw error;
        }
      });
    }
    const successful = async (input: Parameters<typeof runLiveRecoveryEvidence>[0]) => {
      failures.length = 0;
      try {
        return await runLiveRecoveryEvidence(input);
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({ diagnostic: "controlled-recovery-assertion", failures: failures.slice(-4) })}\n`,
        );
        throw error;
      }
    };
    const common = {
      candidatePath: manifestPath,
      installationPath,
      fixture: resolve(repository, "tests/clients/fixtures/local.json"),
      deploymentPath,
      proofsPath,
    };
    process.env.GITHUB_JOB = "wrong-job";
    await assert.rejects(
      runLiveRecoveryEvidence({ ...common, out: resolve(root, "bad-frame") }),
      /unavailable/,
    );
    assert.equal(credentialReads, 0);
    assert.equal(cloudReads, 0);
    assert.equal(childCalls, 0);
    process.env.GITHUB_JOB = "operate";
    for (const fault of ["superseded", "failed-job", "integrated-source"]) {
      authorityFault = fault;
      await assert.rejects(
        runLiveRecoveryEvidence({ ...common, out: resolve(root, fault) }),
        /unavailable/,
      );
      assert.equal(credentialReads, 0);
      assert.equal(cloudReads, 0);
      assert.equal(childCalls, 0);
    }
    authorityFault = "";
    const installedBytes = await readFile(resolve(cliRoot, "dist/wrangler.js"));
    await chmod(resolve(cliRoot, "dist/wrangler.js"), 0o600);
    await writeFile(
      resolve(cliRoot, "dist/wrangler.js"),
      Buffer.concat([installedBytes, Buffer.from("\n")]),
    );
    await chmod(resolve(cliRoot, "dist/wrangler.js"), 0o444);
    try {
      await assert.rejects(
        runLiveRecoveryEvidence({ ...common, out: resolve(root, "bad-installed") }),
        /unavailable/,
      );
      assert.equal(credentialReads, 0);
      assert.equal(cloudReads, 0);
      assert.equal(childCalls, 0);
    } finally {
      await chmod(resolve(cliRoot, "dist/wrangler.js"), 0o600);
      await writeFile(resolve(cliRoot, "dist/wrangler.js"), installedBytes);
      await chmod(resolve(cliRoot, "dist/wrangler.js"), 0o444);
    }
    const out = resolve(root, "claims");
    const result = await successful({ ...common, out });
    assert.equal(
      integratedDownloads,
      2,
      "Original predecessor is authenticated before keys and again after the child",
    );
    assert.equal(f.calls.length, 2);
    const child = (await readJson(resolve(out, "gate.json"))) as GateReceipt;
    await verifyPayload(out, child.files, ["gate.json"]);
    assert.equal(result.currentReceiptPath, `${deploymentPath}.provider-version.json`);
    assert.equal(result.recoveryFactsPath, `${out}.recovery-link.json`);
    const link = object(await readJson(result.recoveryFactsPath));
    assert.deepEqual(link.childStartupObservation, f.input.before);
    assert.equal(object(link.current).workerVersionId, v1);
    assert.equal(
      link.transitionSha256,
      sha256(await readFile(resolve(out, "provider-recovery/transition.json"))),
    );
    assert.equal(
      link.proofSha256,
      sha256(await readFile(resolve(out, "provider-recovery/application-recovery.json"))),
    );
    assert.equal(link.originalCliSha256, sha256(originalCli));
    assert.equal(link.currentReceiptSha256, sha256(await readFile(result.currentReceiptPath)));
    assert.deepEqual(await readFile(deploymentPath), originalBytes);
    assert.deepEqual(await readFile(`${deploymentPath}.cli.json`), originalCli);
    assert.deepEqual(
      await readFile(resolve(out, "provider-recovery/original-deployment.cli.json")),
      originalCli,
    );
    const originalDirectory = resolve(root, "proofs/original/payload");
    await mkdir(originalDirectory, { recursive: true });
    await cp(out, resolve(originalDirectory, "claims"), { recursive: true });
    const retained: GateReceipt = {
      ...child,
      claims: child.claims.map((claim) => ({
        ...claim,
        result: { ...claim.result, path: `claims/${claim.result.path}` },
      })),
      producer: { ...child.producer, workflowId: 71, runId: 81 },
      deployments: [link.current as DeploymentIdentity],
      files: await inventory(originalDirectory),
    };
    await saveJson(resolve(originalDirectory, "gate.json"), retained);
    for (const file of await inventory(originalDirectory))
      await chmod(resolve(originalDirectory, file.path), 0o644);
    originalZip = await directoryArchive(originalDirectory);
    originalReference = {
      runId: 81,
      runAttempt: 1,
      artifactId: 83,
      artifactName: `live-${sourceCommit}-${c.scope}-81-1`,
      artifactDigest: `sha256:${sha256(originalZip.bytes)}`,
      candidateSha256: manifestHash,
    };
    const verifyProofsPath = resolve(root, "verify-proofs.json");
    await saveJson(verifyProofsPath, {
      schemaVersion: 1,
      candidateArtifact: originalReference,
      proofs: [
        { artifact: originalReference, directory: originalDirectory },
        { artifact: integratedReference, directory: integratedDirectory },
      ],
    });
    common.proofsPath = verifyProofsPath;
    const verifyDeployment = resolve(root, "verify-deployment.json");
    await saveJson(verifyDeployment, link.current);
    await copyFile(result.currentReceiptPath, `${verifyDeployment}.cli.json`);
    process.env.OPERATION = "verify";
    process.env.CONFIRM = `verify ${c.tag} ${sourceCommit} ${c.scope}`;
    const originalFiles = await inventory(originalDirectory);
    const verified = await successful({
      ...common,
      deploymentPath: verifyDeployment,
      out: resolve(root, "verify-claims"),
    });
    assert.equal(f.calls.length, 2, "Verification must have no provider effects");
    assert.equal(integratedDownloads, 4);
    assert.equal(copiedRecords.length, 2);
    for (const path of copiedRecords) assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal(privateRecords.length, 2);
    for (const path of privateRecords) {
      assert.ok(!copiedRecords.includes(path));
      await assert.rejects(lstat(path), { code: "ENOENT" });
    }
    assert.deepEqual(await inventory(originalDirectory), originalFiles);
    const verifiedLink = object(await readJson(verified.recoveryFactsPath));
    assert.deepEqual(verifiedLink.childStartupObservation, verifiedLink.current);
    assert.equal(verifiedLink.transitionSha256, link.transitionSha256);
    assert.equal(verifiedLink.proofSha256, link.proofSha256);
    const verifyGate = (await readJson(resolve(root, "verify-claims/gate.json"))) as GateReceipt;
    await verifyPayload(resolve(root, "verify-claims"), verifyGate.files, ["gate.json"]);
    const localResultPath = resolve(integratedDirectory, "claims/infrastructure-boundaries.json");
    const localResult = await readFile(localResultPath);
    childMode = "tamper-local";
    try {
      await assert.rejects(
        runLiveRecoveryEvidence({
          ...common,
          deploymentPath: verifyDeployment,
          out: resolve(root, "tampered-local"),
        }),
        /unavailable/,
      );
      assert.equal(f.calls.length, 2, "Changed predecessor cannot cause a provider write");
      assert.equal(
        integratedDownloads,
        6,
        "The changed payload must be refused by post-child authentication",
      );
      assert.equal(object(object(await readJson(localResultPath)).observation).substituted, true);
      await assert.rejects(lstat(resolve(root, "tampered-local.recovery-link.json")), {
        code: "ENOENT",
      });
    } finally {
      await writeFile(localResultPath, localResult);
    }
    process.env.OPERATION = "deploy";
    process.env.CONFIRM = frame.CONFIRM;
    childMode = "omit-phases";
    await assert.rejects(
      runLiveRecoveryEvidence({
        ...common,
        deploymentPath: verifyDeployment,
        out: resolve(root, "incomplete"),
      }),
      /unavailable/,
    );
    assert.equal(f.calls.length, 2, "Missing phases cannot invent another provider operation");
    process.stdout.write(
      "Controlled outer perform/verify, immutable inventory, pre-credential guards and incomplete-phase refusal passed.\n",
    );
  } finally {
    process.env = ordinaryEnvironment;
    globalThis.fetch = nativeFetch;
    for (const [method, original] of assertMethods) Reflect.set(assert, method, original);
    mock.restoreAll();
    await originalZip?.close();
    await integratedZip?.close();
    await closeFixture?.();
    if (root) await discard(root);
  }
}

if (process.argv.includes("--controlled-recovery")) {
  await controlled();
} else {
  test("trusted outer recovery preserves original receipts and child byte closure across perform/readonly verification", {
    timeout: 240000,
  }, async () => {
    const result = await promisify(execFile)(
      process.execPath,
      ["--experimental-test-module-mocks", import.meta.filename, "--controlled-recovery"],
      { cwd: repository, env: childEnvironment(), timeout: 220000, maxBuffer: 2_000_000 },
    );
    assert.match(result.stdout, /pre-credential guards and incomplete-phase refusal passed/);
  });
}
