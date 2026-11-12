import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "fortipi-contract";
import type { AssetManifest } from "./asset-manifest.js";
import { assetPath } from "./asset-manifest.js";
import type { OperatorConfig } from "./config.js";
import { operatorConfig, readConfig, readJson } from "./config.js";
import { CliError, check } from "./errors.js";
import { safeParents } from "./profiles.js";
import { cliPackageRoot } from "./wrangler.js";

export const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const relativeAsset = (path: string) =>
  /^(worker|contracts|templates|linux|licenses)\//.test(path) &&
  assetPath(path) &&
  !/(^|\/)(\.env[^/]*|auth\.json|node_modules|\.wrangler)(\/|$)/.test(path);
async function walk(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    check(!item.isSymbolicLink(), "linked_asset", 3);
    if (item.isDirectory()) files.push(...(await walk(join(root, item.name), path)));
    else {
      check(item.isFile(), "invalid_asset_type", 3);
      files.push(path);
    }
  }
  return files.sort();
}
export async function verifyAssets(
  root = join(cliPackageRoot, "worker-assets"),
): Promise<{ manifest: AssetManifest; manifestSha256: string }> {
  let bytes: Buffer;
  try {
    const stat = await lstat(join(root, "asset-manifest.json"));
    check(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1048576,
      "invalid_asset_manifest",
      3,
    );
    bytes = await readFile(join(root, "asset-manifest.json"));
  } catch {
    throw new CliError("actual_service5_worker_assets_required", 3);
  }
  check(
    !(await lstat(root)).isSymbolicLink() && bytes.length <= 1048576,
    "invalid_asset_manifest",
    3,
  );
  const manifest = (await readJson(join(root, "asset-manifest.json"))) as AssetManifest;
  check(
    manifest &&
      manifest.schemaVersion === 1 &&
      /^\d+\.\d+\.\d+$/.test(manifest.packageVersion) &&
      /^[a-f0-9]{40}$/.test(manifest.sourceCommit) &&
      /^[a-f0-9]{64}$/.test(manifest.lockSha256) &&
      canonicalJson(manifest.toolchain) ===
        canonicalJson({
          node: "26.13.1",
          pnpm: "12.18.0",
          wrangler: "4.161.0",
          compiler: "7.0.2",
        }) &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= 10000 &&
      relativeAsset(manifest.entry) &&
      manifest.entry.startsWith("worker/"),
    "invalid_asset_manifest",
    3,
  );
  check(
    bytes.toString("utf8") === `${canonicalJson(manifest)}\n`,
    "noncanonical_asset_manifest",
    3,
  );
  const paths = manifest.files.map((f) => f.path);
  check(
    paths.every(relativeAsset) &&
      paths.join() === [...new Set(paths)].sort().join() &&
      new Set(paths.map((p) => p.toLowerCase())).size === paths.length &&
      paths.includes(manifest.entry) &&
      [
        "templates/wrangler.base.json",
        "templates/wrangler.container.json",
        "contracts/openapi.json",
        "linux/container/Dockerfile",
        "linux/image-metadata.json",
      ].every((p) => paths.includes(p)) &&
      paths.some((p) => p.startsWith("licenses/")) &&
      paths.some((p) => p.startsWith("contracts/schemas/")),
    "incomplete_asset_manifest",
    3,
  );
  const actual = (await walk(root)).filter((p) => p !== "asset-manifest.json");
  check(actual.join() === paths.join(), "asset_closure_mismatch", 3);
  for (const record of manifest.files) {
    const path = join(root, record.path);
    const stat = await lstat(path);
    check(
      stat.nlink === 1 &&
        record.kind ===
          (
            {
              worker: "worker",
              contracts: "contract",
              templates: "template",
              linux: "linux",
              licenses: "license",
            } as Record<string, string>
          )[record.path.split("/")[0] ?? ""] &&
        Number.isSafeInteger(record.size) &&
        record.size >= 0 &&
        stat.size === record.size &&
        /^[a-f0-9]{64}$/.test(record.sha256) &&
        sha256(await readFile(path)) === record.sha256,
      "asset_integrity_failed",
      3,
    );
  }
  const image = (await readJson(join(root, "linux/image-metadata.json"))) as Record<
    string,
    unknown
  >;
  check(
    manifest.image &&
      manifest.image.metadataSha256 ===
        sha256(await readFile(join(root, "linux/image-metadata.json"))) &&
      manifest.image.sourceCommit === image.sourceCommit &&
      manifest.image.imageId === image.imageId &&
      manifest.image.builtManifestDigest === image.builtManifestDigest &&
      manifest.image.registryDigest === null &&
      image.registryDigest === null &&
      manifest.image.platform === "linux/amd64" &&
      image.platform === "linux/amd64" &&
      /^[a-f0-9]{40}$/.test(manifest.image.sourceCommit) &&
      /^sha256:[a-f0-9]{64}$/.test(manifest.image.imageId) &&
      /^sha256:[a-f0-9]{64}$/.test(manifest.image.builtManifestDigest) &&
      manifest.image.contextInventorySha256 ===
        sha256(canonicalJson(manifest.files.filter((r) => r.path.startsWith("linux/container/")))),
    "image_provenance_changed",
    3,
  );
  return { manifest, manifestSha256: sha256(bytes) };
}
type WranglerConfig = Record<string, unknown> & {
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { tag: string; new_sqlite_classes?: string[] }[];
  compatibility_flags: string[];
};
export interface MigrationHistory {
  sourceCommit: string;
  assetManifestSha256: string;
  migrations: WranglerConfig["migrations"];
  containers: boolean;
  loaders: boolean;
}
export async function composeDeployment(
  config: OperatorConfig,
  assets: string,
  manifest: AssetManifest,
  history?: MigrationHistory,
): Promise<WranglerConfig> {
  operatorConfig(config);
  const base = (await readJson(join(assets, "templates/wrangler.base.json"))) as WranglerConfig;
  check(
    base?.durable_objects &&
      Array.isArray(base.durable_objects.bindings) &&
      Array.isArray(base.migrations) &&
      base.compatibility_flags.includes("nodejs_compat") &&
      typeof base.compatibility_date === "string" &&
      ["ControlPlane", "AgentSession", "WorkspaceObject"].every((c) =>
        base.migrations.some((m) => m.new_sqlite_classes?.includes(c)),
      ) &&
      [
        ["CONTROL_PLANE", "ControlPlane"],
        ["AGENT_SESSIONS", "AgentSession"],
        ["WORKSPACES", "WorkspaceObject"],
      ].every(([n, c]) =>
        base.durable_objects.bindings.some((b) => b.name === n && b.class_name === c),
      ),
    "canonical_worker_template_required",
    3,
  );
  const allowed = [
    "main",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "durable_objects",
    "migrations",
    "ai",
    "rules",
    "find_additional_modules",
    "observability",
    "limits",
    "no_bundle",
  ];
  check(
    Object.keys(base).every((k) => allowed.includes(k)),
    "unexpected_template_field",
    3,
  );
  check(!base.worker_loaders && !base.containers && !base.r2_buckets, "invalid_free_template", 3);
  if (config.runtime.execution.kind === "cloud-js") base.worker_loaders = [{ binding: "LOADER" }];
  if (config.runtime.execution.kind === "linux") {
    const overlay = (await readJson(
      join(assets, "templates/wrangler.container.json"),
    )) as WranglerConfig;
    check(
      overlay &&
        Object.keys(overlay).every((k) =>
          ["compatibility_flags", "durable_objects", "migrations", "containers"].includes(k),
        ),
      "invalid_container_overlay",
      3,
    );
    base.durable_objects.bindings.push(...overlay.durable_objects.bindings);
    base.migrations.push(...overlay.migrations);
    base.containers = overlay.containers;
    check(
      manifest.image && manifest.image.builtManifestDigest === config.runtime.execution.imageDigest,
      "reviewed_linux_image_digest_required",
      3,
    );
    for (const container of base.containers as {
      class_name: string;
      images: Record<string, { dockerfile: string; build_context: string }>;
    }[]) {
      check(
        container.class_name === "LinuxContainerHost" &&
          Object.keys(container.images).join() === "computerd" &&
          container.images.computerd?.dockerfile === "./assets/linux/container/Dockerfile" &&
          container.images.computerd.build_context === "./assets/linux/container",
        "image_context_changed",
        3,
      );
    }
  }
  if (history) {
    check(
      /^[a-f0-9]{40}$/.test(history.sourceCommit) &&
        /^[a-f0-9]{64}$/.test(history.assetManifestSha256) &&
        Array.isArray(history.migrations) &&
        history.migrations.length > 0 &&
        history.migrations.length <= 32 &&
        typeof history.containers === "boolean" &&
        typeof history.loaders === "boolean" &&
        (!history.containers || config.runtime.execution.kind === "linux") &&
        (!history.loaders || config.runtime.execution.kind === "cloud-js") &&
        history.migrations.length <= base.migrations.length &&
        canonicalJson(base.migrations.slice(0, history.migrations.length)) ===
          canonicalJson(history.migrations),
      "migration_history_requires_explicit_repair",
      3,
    );
  }
  return {
    ...base,
    name: config.deployment.name,
    main: `./assets/${manifest.entry}`,
    ...(config.deployment.accountId ? { account_id: config.deployment.accountId } : {}),
    vars: { FORTIPI_CONFIG: config.runtime },
  };
}
export interface PrepareReceipt {
  schemaVersion: 1;
  packageVersion: string;
  sourceCommit: string;
  assetManifestSha256: string;
  configSha256: string;
  operator: OperatorConfig;
  history?: MigrationHistory;
}
export async function prepare(
  configPath: string,
  directory: string,
  previousDirectory?: string,
): Promise<PrepareReceipt> {
  const config = await readConfig(configPath);
  const source = join(cliPackageRoot, "worker-assets");
  const { manifest, manifestSha256 } = await verifyAssets(source);
  let history: MigrationHistory | undefined;
  if (previousDirectory) {
    const previous = resolve(previousDirectory);
    await safeParents(previous);
    const receipt = (await readJson(join(previous, "prepare-receipt.json"))) as PrepareReceipt;
    const prior = await verifyAssets(join(previous, "assets"));
    operatorConfig(receipt.operator);
    check(
      receipt.schemaVersion === 1 &&
        receipt.assetManifestSha256 === prior.manifestSha256 &&
        receipt.sourceCommit === prior.manifest.sourceCommit &&
        receipt.packageVersion === prior.manifest.packageVersion &&
        receipt.configSha256 === sha256(canonicalJson(receipt.operator.runtime)) &&
        receipt.operator.deployment.name === config.deployment.name &&
        receipt.operator.deployment.origin === config.deployment.origin &&
        receipt.operator.deployment.accountId === config.deployment.accountId,
      "previous_deployment_identity_changed",
      3,
    );
    const priorConfig = await composeDeployment(
      receipt.operator,
      join(previous, "assets"),
      prior.manifest,
      receipt.history,
    );
    check(
      canonicalJson(await readJson(join(previous, "wrangler.json"))) === canonicalJson(priorConfig),
      "previous_config_changed",
      3,
    );
    history = {
      sourceCommit: prior.manifest.sourceCommit,
      assetManifestSha256: prior.manifestSha256,
      migrations: priorConfig.migrations,
      containers: receipt.operator.runtime.execution.kind === "linux",
      loaders: receipt.operator.runtime.execution.kind === "cloud-js",
    };
  }
  const wrangler = await composeDeployment(config, source, manifest, history);
  directory = resolve(directory);
  await safeParents(dirname(directory));
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch {
    throw new CliError("fresh_prepare_directory_required", 3);
  }
  await mkdir(join(directory, "assets"), { mode: 0o700 });
  for (const path of ["asset-manifest.json", ...manifest.files.map((f) => f.path)]) {
    const destination = join(directory, "assets", path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(join(source, path), destination, 1);
  }
  const receipt: PrepareReceipt = {
    schemaVersion: 1,
    packageVersion: manifest.packageVersion,
    sourceCommit: manifest.sourceCommit,
    assetManifestSha256: manifestSha256,
    configSha256: sha256(canonicalJson(config.runtime)),
    operator: config,
    ...(history ? { history } : {}),
  };
  await writeFile(join(directory, "wrangler.json"), `${canonicalJson(wrangler)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(directory, "prepare-receipt.json"), `${canonicalJson(receipt)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return receipt;
}
export async function verifyPrepared(directory: string): Promise<PrepareReceipt> {
  await safeParents(directory);
  const receipt = (await readJson(join(directory, "prepare-receipt.json"))) as PrepareReceipt;
  check(receipt && receipt.schemaVersion === 1, "invalid_prepare_receipt", 3);
  operatorConfig(receipt.operator);
  const installed = await verifyAssets();
  const prepared = await verifyAssets(join(directory, "assets"));
  check(
    installed.manifestSha256 === prepared.manifestSha256 &&
      receipt.assetManifestSha256 === installed.manifestSha256 &&
      receipt.configSha256 === sha256(canonicalJson(receipt.operator.runtime)) &&
      receipt.sourceCommit === installed.manifest.sourceCommit &&
      receipt.packageVersion === installed.manifest.packageVersion,
    "prepared_asset_identity_changed",
    3,
  );
  const expected = await composeDeployment(
    receipt.operator,
    join(directory, "assets"),
    installed.manifest,
    receipt.history,
  );
  check(
    canonicalJson(await readJson(join(directory, "wrangler.json"))) === canonicalJson(expected),
    "prepared_config_changed",
    3,
  );
  const entries = await readdir(directory);
  check(
    entries.every((p) => ["assets", "wrangler.json", "prepare-receipt.json"].includes(p)),
    "unexpected_prepared_file",
    3,
  );
  return receipt;
}
