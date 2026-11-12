import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { canonicalJson } from "fortipi-contract";
import { prepare, verifyAssets, verifyPrepared } from "../dist/assets.js";
import { deploy } from "../dist/deployment.js";
import { packageWorkerAssets, regularFiles } from "../scripts/package-worker-assets.ts";
import { config, temp } from "./fixtures.ts";

const root = resolve(new URL("../../../", import.meta.url).pathname);
const assets = resolve(root, "packages/fortipi-cli/worker-assets");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

test("actual emitted asset closure is reproducible and preserves independent Free/paid choices and migration history", async (t) => {
  const directory = await temp(t);
  const first = await verifyAssets();
  const manifestBytes = await readFile(join(assets, "asset-manifest.json"));
  const independent = await regularFiles(assets);
  assert.deepEqual(
    independent.filter((p) => p !== "asset-manifest.json").sort(),
    first.manifest.files.map((f) => f.path),
  );
  for (const record of first.manifest.files) {
    const bytes = await readFile(join(assets, record.path));
    assert.equal(hash(bytes), record.sha256);
    assert.equal(bytes.length, record.size);
  }
  const commit = (
    await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  await packageWorkerAssets({
    workerBuild: "apps/worker/dist/worker",
    commit,
    version: first.manifest.packageVersion,
  });
  assert.deepEqual(await readFile(join(assets, "asset-manifest.json")), manifestBytes);
  const native = await config();
  native.runtime.workspace = { kind: "local", executorId: "my-device", rootBindingId: "my-root" };
  const input = join(directory, "operator.json");
  await writeFile(input, JSON.stringify(native));
  const freeDir = join(directory, "free");
  await prepare(input, freeDir);
  const free = JSON.parse(await readFile(join(freeDir, "wrangler.json"), "utf8"));
  assert.equal(free.worker_loaders, undefined);
  assert.equal(free.containers, undefined);
  assert.equal(free.durable_objects.bindings.length, 3);
  assert.deepEqual(free.migrations, [
    { tag: "v1", new_sqlite_classes: ["ControlPlane", "AgentSession", "WorkspaceObject"] },
  ]);
  assert.equal(free.vars.FORTIPI_CONFIG.workspace.kind, "local");
  assert.equal(free.vars.FORTIPI_CONFIG.execution.kind, "native");
  await verifyPrepared(freeDir);
  const paid = structuredClone(native);
  paid.runtime.infrastructure.profile = "verified";
  paid.runtime.infrastructure.accountPlan = "paid";
  paid.runtime.infrastructure.capabilities = [
    {
      capability: "loader",
      state: "available",
      accountPlan: "paid",
      deploymentId: paid.deployment.name,
      observedAt: 1,
    },
  ];
  paid.runtime.execution = {
    kind: "cloud-js",
    backendId: "js",
    modules: [],
    egress: [],
    onInterrupt: "fail",
  };
  await writeFile(input, JSON.stringify(paid));
  const jsDir = join(directory, "js");
  await prepare(input, jsDir, freeDir);
  const js = JSON.parse(await readFile(join(jsDir, "wrangler.json"), "utf8"));
  assert.deepEqual(js.worker_loaders, [{ binding: "LOADER" }]);
  assert.equal(js.containers, undefined);
  assert.deepEqual(js.migrations, free.migrations);
  paid.runtime.infrastructure.capabilities.push({
    capability: "containers",
    state: "available",
    accountPlan: "paid",
    deploymentId: paid.deployment.name,
    observedAt: 1,
  });
  assert.ok(first.manifest.image);
  paid.runtime.execution = {
    kind: "linux",
    backendId: "linux",
    host: "container",
    imageDigest: first.manifest.image.builtManifestDigest,
    runtime: { cpuMs: 1000, memoryBytes: 1048576, timeoutMs: 1000 },
  };
  await writeFile(input, JSON.stringify(paid));
  const linuxDir = join(directory, "linux");
  await prepare(input, linuxDir, freeDir);
  const linux = JSON.parse(await readFile(join(linuxDir, "wrangler.json"), "utf8"));
  assert.equal(linux.worker_loaders, undefined);
  assert.equal(linux.durable_objects.bindings.length, 4);
  assert.deepEqual(linux.migrations, [
    ...free.migrations,
    { tag: "v2-linux", new_sqlite_classes: ["LinuxContainerHost"] },
  ]);
  assert.deepEqual(linux.containers[0].images.computerd, {
    dockerfile: "./assets/linux/container/Dockerfile",
    build_context: "./assets/linux/container",
  });
  await verifyPrepared(linuxDir);
  await writeFile(input, JSON.stringify(native));
  await assert.rejects(
    prepare(input, join(directory, "downgrade"), linuxDir),
    /migration_history_requires_explicit_repair/,
  );
  await assert.rejects(lstat(join(directory, "downgrade")), { code: "ENOENT" });
});

test("real prepared bytes, missing files and path escape are rejected before any Wrangler child", async (t) => {
  const directory = await temp(t);
  const input = join(directory, "operator.json");
  await writeFile(input, JSON.stringify(await config()));
  const prepared = join(directory, "prepared");
  await prepare(input, prepared);
  const { manifest } = await verifyAssets();
  const entry = join(prepared, "assets", manifest.entry);
  await writeFile(entry, "// altered packaged module\n");
  let spawned = 0;
  await assert.rejects(
    deploy(
      prepared,
      { dryRun: true },
      {
        async run() {
          spawned++;
          return "";
        },
      },
    ),
    /asset_integrity_failed/,
  );
  assert.equal(spawned, 0);
  const copy = join(directory, "copy");
  await cp(assets, copy, { recursive: true });
  const bytes = JSON.parse(await readFile(join(copy, "asset-manifest.json"), "utf8"));
  bytes.files[0].path = "../outside";
  await writeFile(join(copy, "asset-manifest.json"), `${canonicalJson(bytes)}\n`);
  await assert.rejects(verifyAssets(copy), /incomplete_asset_manifest/);
});
