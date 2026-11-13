import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson } from "fortipi-contract";
import { dependencyPatches } from "../../../scripts/dependency-patches.ts";
import {
  offlineWranglerEnvironment,
  verifyOfflineWranglerAuth,
} from "../../../tests/clients/offline-wrangler.ts";
import { prepare, verifyAssets, verifyPrepared } from "../dist/assets.js";
import { deploy } from "../dist/deployment.js";
import { wranglerBin } from "../dist/wrangler.js";
import { packageWorkerAssets, regularFiles } from "../scripts/package-worker-assets.ts";
import { config, temp } from "./fixtures.ts";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
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
  const reproduction = join(root, "dist", `cli-assets-reproduction-${randomUUID()}`);
  t.after(() => rm(reproduction, { recursive: true, force: true }));
  const reproduce = () =>
    packageWorkerAssets({
      workerBuild: "apps/worker/dist/worker",
      commit,
      version: first.manifest.packageVersion,
      outputDirectory: reproduction,
    });
  await reproduce();
  assert.deepEqual(await readFile(join(reproduction, "asset-manifest.json")), manifestBytes);
  const patch = (await dependencyPatches(root, true))["agents@0.33.0"];
  assert.ok(patch);
  const stagedPatch = join(root, "dist/supply-chain/licenses/agents@0.33.0", patch.path);
  const originalPatch = await readFile(stagedPatch);
  assert.equal(hash(originalPatch), patch.sha256);
  const bundledPatch = `licenses/agents_0.33.0/${patch.path}`;
  assert.equal(
    first.manifest.files.find((file) => file.path === bundledPatch)?.sha256,
    patch.sha256,
  );
  assert.deepEqual(await readFile(join(reproduction, bundledPatch)), originalPatch);
  try {
    await rm(stagedPatch);
    await assert.rejects(reproduce, /Missing reviewed bundled dependency patch: agents@0\.33\.0/);
    assert.deepEqual(await readFile(join(reproduction, "asset-manifest.json")), manifestBytes);
    assert.deepEqual(await readFile(join(reproduction, bundledPatch)), originalPatch);
    await writeFile(stagedPatch, Buffer.concat([originalPatch, Buffer.from("\nchanged\n")]));
    await assert.rejects(reproduce, /Bundled dependency patch changed: agents@0\.33\.0/);
    assert.deepEqual(await readFile(join(reproduction, "asset-manifest.json")), manifestBytes);
    assert.deepEqual(await readFile(join(reproduction, bundledPatch)), originalPatch);
  } finally {
    await writeFile(stagedPatch, originalPatch);
  }
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

test("operator origins survive normal prepare history and govern the actual Worker router", async (t) => {
  const directory = await temp(t);
  const input = join(directory, "operator.json");
  const original = await config();
  await writeFile(input, JSON.stringify(original));
  const firstDirectory = join(directory, "default");
  const first = await prepare(input, firstDirectory);
  const initial = JSON.parse(await readFile(join(firstDirectory, "wrangler.json"), "utf8"));
  assert.equal(initial.vars.FORTIPI_ALLOWED_ORIGINS, undefined);
  const allowed = ["https://127.0.0.1:10110", "https://app.example"];
  await verifyOfflineWranglerAuth(await wranglerBin());
  const checkRouter = async (prepared: string, permits: boolean) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import assert from 'node:assert/strict';
          import { readFile } from 'node:fs/promises';
          import { join, resolve } from 'node:path';
          import { unstable_dev } from 'wrangler';
          const prepared=process.argv[1], permits=process.argv[2]==='true';
          const allowed=${JSON.stringify(allowed)};
          const configPath=join(prepared,'wrangler.json');
          const config=JSON.parse(await readFile(configPath,'utf8'));
          const server=await unstable_dev(resolve(prepared,config.main),{
            config:configPath,local:true,ip:'127.0.0.1',port:0,inspectorPort:0,
            persist:false,logLevel:'none',
            experimental:{forceLocal:true,disableDevRegistry:true,disableExperimentalWarning:true,watch:false}
          });
          try {
            for(const origin of [...allowed,'https://127.0.0.1:10111','https://foreign.example'])
              for(const method of ['OPTIONS','GET']) {
                const response=await server.fetch('/health',{
                  method, headers:{Origin:origin,...(method==='OPTIONS'?{'Access-Control-Request-Method':'GET'}:{})}
                });
                const accepted=permits&&allowed.includes(origin);
                assert.equal(response.status,accepted?(method==='OPTIONS'?204:200):403);
                assert.equal(response.headers.get('Access-Control-Allow-Origin'),accepted?origin:null);
                await response.arrayBuffer();
              }
          } finally { await server.stop(); }
        `,
        prepared,
        String(permits),
      ],
      {
        cwd: join(root, "packages/fortipi-cli"),
        env: offlineWranglerEnvironment(directory),
        timeout: 30000,
        maxBuffer: 65536,
      },
    );
  };
  await checkRouter(firstDirectory, false);
  const optedIn = { ...original, deployment: { ...original.deployment, allowedOrigins: allowed } };
  await writeFile(input, JSON.stringify(optedIn));
  const secondDirectory = join(directory, "opt-in");
  const second = await prepare(input, secondDirectory, firstDirectory);
  const path = join(secondDirectory, "wrangler.json");
  const bytes = await readFile(path);
  const prepared = JSON.parse(bytes.toString());
  assert.deepEqual(second.operator, optedIn);
  assert.equal(second.configSha256, first.configSha256, "configSha256 remains runtime-only");
  assert.deepEqual(prepared.vars.FORTIPI_ALLOWED_ORIGINS, allowed);
  assert.deepEqual(prepared.vars.FORTIPI_CONFIG, original.runtime);
  assert.deepEqual(prepared.migrations, initial.migrations);
  assert.deepEqual((await verifyPrepared(secondDirectory)).operator, optedIn);
  await checkRouter(secondDirectory, true);
  prepared.vars.FORTIPI_ALLOWED_ORIGINS = ["https://foreign.example"];
  await writeFile(path, JSON.stringify(prepared));
  await assert.rejects(verifyPrepared(secondDirectory), /prepared_config_changed/);
  await assert.rejects(
    prepare(input, join(directory, "tampered-history"), secondDirectory),
    /previous_config_changed/,
  );
  await writeFile(path, bytes);
  await writeFile(input, JSON.stringify(original));
  const restoredDirectory = join(directory, "removed");
  await prepare(input, restoredDirectory, secondDirectory);
  const restored = JSON.parse(await readFile(join(restoredDirectory, "wrangler.json"), "utf8"));
  assert.equal(restored.vars.FORTIPI_ALLOWED_ORIGINS, undefined);
  await verifyPrepared(restoredDirectory);
});

test("dry-build success requires real emitted module bytes, not only a successful subprocess exit", async (t) => {
  const directory = await temp(t);
  const input = join(directory, "operator.json");
  await writeFile(input, JSON.stringify(await config()));
  const prepared = join(directory, "prepared");
  await prepare(input, prepared);
  await assert.rejects(
    deploy(
      prepared,
      { dryRun: true },
      {
        async run() {
          return "";
        },
      },
    ),
    /wrangler_dry_build_module_identity_failed/,
  );
  const { manifest } = await verifyAssets();
  const result = await deploy(
    prepared,
    { dryRun: true },
    {
      async run(request) {
        const at = request.args.indexOf("--outdir");
        const out = request.args[at + 1];
        assert.ok(at >= 0 && out);
        for (const file of manifest.files.filter((f) => f.kind === "worker")) {
          const path = join(out, file.path.slice("worker/".length));
          await mkdir(join(path, ".."), { recursive: true });
          await cp(join(assets, file.path), path);
        }
        return "";
      },
    },
  );
  assert.equal("workerBytesVerified" in result && result.workerBytesVerified, true);
});
