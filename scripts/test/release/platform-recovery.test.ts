// Unit-only provider protocol fixtures; real staged packages/prepared modules, no CF operation.
import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { repository } from "../../build-workspaces.ts";
import { observeDeployment, type TargetDescriptor } from "../../deploy-smoke.ts";
import { generateNotices } from "../../generate-notices.ts";
import {
  type RecoveryInput,
  type RecoveryPorts,
  recoverProvider,
} from "../../platform-recovery.ts";
import { childEnvironment, execute, generateSbom, stageAndPack } from "../../prepare-release.ts";
import {
  type CandidateManifest,
  canonicalJson,
  inventory,
  object,
  readJson,
  regularBytes,
  saveJson,
  sha256,
} from "../../verify-release-gates.ts";
import { candidate, discard, httpFixture, temporary } from "./fixtures.ts";

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

before(async () => {
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
    accountBindingSha256: sha256("synthetic-account"),
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
});
after(async () => {
  if (root) await discard(root);
});

async function fixture(fault = "") {
  const operationId = (++nextOperation).toString(16).padStart(32, "0");
  const journalDirectory = resolve(root, operationId);
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
  const checkpointDirectory = resolve(root, "application", operationId);
  const beforePath = resolve(checkpointDirectory, "application-before.json");
  // Public checkpoint identity fixture only, never an application-survival assertion.
  await saveJson(beforePath, {
    schemaVersion: 1,
    candidateSha256: manifestHash,
    sourceCommit,
    deploymentId: d0,
    workerVersionId: v0,
    capturedAt: new Date().toISOString(),
  });
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
        const intent = object(await readJson(resolve(journalDirectory, "intent.json")));
        assert.equal(intent.candidateSha256, manifestHash);
        assert.equal(intent.beforeCheckpointSha256, input.beforeCheckpoint.sha256);
        const upload = request.args[1] === "upload";
        await regularBytes(
          resolve(journalDirectory, upload ? "upload-attempt.json" : "deployment-attempt.json"),
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

test("provider phase retains same-byte new-version intent, never qualifies app recovery; verification is strictly read-only", {
  timeout: 120000,
}, async () => {
  const f = await fixture();
  try {
    const result = await recoverProvider({ ...f.input, mode: "perform" }, f.ports);
    assert.equal(result.transition.phase, "provider-confirmed");
    assert.equal(result.transition.requiresApplicationVerification, true);
    assert.equal(result.transition.after.workerVersionId, v1);
    assert.equal(result.transition.strategyReadBack, false);
    assert.equal(result.transition.incarnation, "not-observed");
    assert.equal(result.transition.physicalHostLoss, "not-observed");
    assert.equal(result.transition.beforeCheckpointSha256, f.input.beforeCheckpoint.sha256);
    const files = await inventory(f.input.journalDirectory);
    const retainedTransitionSha256 = sha256(
      await regularBytes(resolve(f.input.journalDirectory, "transition.json")),
    );
    assert.equal(result.transitionSha256, retainedTransitionSha256);
    let unexpectedWrites = 0;
    const readonly = {
      ...f.ports,
      wrangler: {
        async run() {
          unexpectedWrites++;
          assert.fail("verify-existing attempted a write");
        },
      },
    };
    const checked = await recoverProvider(
      { ...f.input, mode: "verify-existing", retainedTransitionSha256 },
      readonly,
    );
    assert.deepEqual(
      checked.transition,
      result.transition,
      "Historical observation time must not become fresh evidence",
    );
    assert.ok(Date.parse(checked.current.checkedAt) >= Date.parse(result.current.checkedAt));
    assert.equal(unexpectedWrites, 0);
    assert.deepEqual(
      await inventory(f.input.journalDirectory),
      files,
      "Read-only verification changed retained facts",
    );
    assert.equal(f.calls.length, 2);
    const safe = (
      await Promise.all(
        (
          await readdir(f.input.journalDirectory)
        ).map((name) => regularBytes(resolve(f.input.journalDirectory, name))),
      )
    ).join();
    for (const forbidden of [
      admin,
      "synthetic-account",
      "synthetic-untrusted",
      "synthetic-provider-secret",
      "synthetic-runner-secret",
    ])
      assert.equal(safe.includes(forbidden), false);
    f.wrongActive();
    await assert.rejects(
      recoverProvider({ ...f.input, mode: "verify-existing", retainedTransitionSha256 }, readonly),
    );
  } finally {
    await f.close();
  }
});

test("uncertain writes reconcile exact retained intent, without repeating upload or deployment", {
  timeout: 120000,
}, async () => {
  for (const fault of ["ambiguous-upload", "ambiguous-deploy", "upload-absent"]) {
    const f = await fixture(fault);
    try {
      await assert.rejects(
        recoverProvider({ ...f.input, mode: "perform" }, f.ports),
        (e: Error) => {
          assert.equal(
            e.message,
            "Platform recovery unavailable or inconsistent; no recovery claim qualified",
          );
          return true;
        },
      );
      f.reconnect();
      if (fault === "upload-absent")
        await assert.rejects(recoverProvider({ ...f.input, mode: "perform" }, f.ports));
      else {
        const recovered = await recoverProvider({ ...f.input, mode: "perform" }, f.ports);
        assert.equal(recovered.transition.after.workerVersionId, v1);
      }
      assert.equal(f.calls.filter((args) => args[1] === "upload").length, 1);
      assert.equal(
        f.calls.filter((args) => args[1] === "deploy").length,
        fault === "upload-absent" ? 0 : 1,
      );
    } finally {
      await f.close();
    }
  }
});

test("candidate/prepared identity, distinct version and inherited module/binding/namespace/secret guards fail before deployment", {
  timeout: 180000,
}, async () => {
  for (const fault of [
    "candidate",
    "checkpoint",
    "prepared",
    "same",
    "bytes",
    "binding",
    "namespace",
    "secret",
    "latest",
  ]) {
    const f = await fixture(fault);
    const configPath = resolve(prepared, "wrangler.json");
    const original = await regularBytes(configPath);
    try {
      if (fault === "candidate") f.input.candidateSha256 = sha256("wrong-candidate");
      if (fault === "checkpoint") f.input.beforeCheckpoint.sha256 = sha256("wrong-checkpoint");
      if (fault === "prepared")
        await writeFile(configPath, `${canonicalJson({ ...config, name: "other" })}\n`);
      await assert.rejects(recoverProvider({ ...f.input, mode: "perform" }, f.ports));
      assert.equal(f.calls.filter((args) => args[1] === "deploy").length, 0);
      assert.equal(f.calls.length, ["candidate", "prepared", "checkpoint"].includes(fault) ? 0 : 1);
    } finally {
      if (fault === "prepared") await writeFile(configPath, original);
      await f.close();
      await rm(f.input.journalDirectory, { recursive: true, force: true });
    }
  }
});
