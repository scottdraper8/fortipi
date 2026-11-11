// CI-only canonical-tar import into a second, independently provisioned private store.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { repository } from "../../../scripts/build-workspaces.ts";
import { archiveEntries, hash } from "../../../tools/unstale/review-supply-chain.ts";
import { inspectImageArchive, type SavedImage } from "./image-archive.ts";
import { assertRuntimeConfig, type ImageConfig, type PrunePolicy } from "./image-prune.ts";

const execute = promisify(execFile);
const directory = resolve(repository, "apps/worker/dist/container");
const receiptPath = resolve(directory, "recipient-proof.json");
const imageTag = "fortipi-computerd:verified";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const reasons = [
  "unknown",
  "prerequisite",
  "source-audit",
  "docker-binding",
  "builder-idle",
  "receipt",
  "receipt-phase",
  "source-match",
  "same-id",
  "same-root",
  "same-socket",
  "same-process",
  "same-namespace",
  "store-query",
  "store-types",
  "store-images",
  "store-containers",
  "store-volumes",
  "store-build-cache",
  "import",
  "image-list",
  "empty-ids",
  "id-count",
  "id-format",
  "multiple-ids",
  "image-inspect",
  "graph-id",
  "os",
  "arch",
  "rootfs",
  "diffids",
  "runtime-config",
  "config-fields",
  "config-equality",
  "tag",
  "postbinding",
  "archive-stability",
  "metadata-stability",
  "receipt-stability",
  "receipt-write",
] as const;
type Reason = (typeof reasons)[number];
type Stage =
  | "prerequisite"
  | "source-audit"
  | "docker-binding"
  | "builder-idle"
  | "recipient-empty"
  | "import"
  | "imported-identity";

class RecipientProofError extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) {
    super("Recipient proof rejected");
    this.name = "RecipientProofError";
    this.reason = reason;
  }
}
// Discard assertion details here; never retain actual/expected, message or cause.
function checked(reason: Reason, assertion: () => void): void {
  try {
    assertion();
  } catch {
    throw new RecipientProofError(reason);
  }
}
export function recipientFailure(stage: Stage, error: unknown, fallback: Reason = "unknown") {
  const reason = error instanceof RecipientProofError ? error.reason : fallback;
  return {
    probe: "recipient-import",
    stage,
    reason: reasons.includes(reason) ? reason : "unknown",
    passed: false,
  };
}
const env = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  DOCKER_HOST: process.env.DOCKER_HOST,
  DOCKER_CONFIG: process.env.DOCKER_CONFIG,
  BUILDX_CONFIG: process.env.BUILDX_CONFIG,
  BUILDX_BUILDER: "default",
};

interface Daemon {
  id: string;
  root: string;
  host: string;
  pid: number;
  start: string;
  rootless: boolean;
  networkNamespace: string;
}
interface Receipt {
  version: 1;
  phase: "builder" | "loaded";
  sourceCommit: string;
  metadataSha256: string;
  archiveSha256: string;
  builder: Daemon;
  recipient?: Daemon;
  imageId?: string;
}
interface Metadata {
  sourceCommit: string;
  archiveSha256: string;
  sourceKitSha256: string;
  runtimeImageConfigSha256: string;
  imageId: string;
  savedImage: SavedImage;
}
interface Inspection {
  Id: string;
  Os: string;
  Architecture: string;
  RootFS: { Type: string; Layers: string[] };
  Config: ImageConfig;
}

async function digest(path: string): Promise<string> {
  assert.ok((await lstat(path)).isFile(), "Proof input must be a regular file");
  const h = createHash("sha256");
  for await (const bytes of createReadStream(path)) h.update(bytes);
  return h.digest("hex");
}
async function command(file: string, args: string[], timeout = 15000): Promise<string> {
  try {
    return (
      await execute(file, args, { env, timeout, maxBuffer: 1024 * 1024, encoding: "utf8" })
    ).stdout.trim();
  } catch {
    throw new Error("Recipient proof command failed");
  }
}
async function docker(args: string[], timeout?: number) {
  return command("docker", args, timeout);
}
async function sourceProof() {
  const metadataPath = resolve(directory, "image-metadata.json");
  const stat = await lstat(metadataPath);
  assert.ok(stat.isFile() && stat.size < 1024 * 1024);
  const metadataBytes = await readFile(metadataPath);
  const metadata = JSON.parse(metadataBytes.toString("utf8")) as Metadata;
  assert.equal(metadata.sourceCommit, await command("git", ["rev-parse", "HEAD"]));
  assert.match(metadata.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(await digest(resolve(directory, "image.tar")), metadata.archiveSha256);
  assert.equal(
    await digest(resolve(directory, "sources-and-notices.tar")),
    metadata.sourceKitSha256,
  );
  const freeze = JSON.parse(
    await readFile(resolve(import.meta.dirname, "debian-freeze.json"), "utf8"),
  ) as { pruning: PrunePolicy };
  const graph = await inspectImageArchive(resolve(directory, "image.tar"), metadata.imageId, {
    pruning: freeze.pruning,
  });
  assert.deepEqual(graph.saved, metadata.savedImage, "Recipient input selected graph changed");
  assert.equal(
    hash(Buffer.from(JSON.stringify(graph.configuration))),
    metadata.runtimeImageConfigSha256,
  );
  return { metadata, graph, metadataSha256: hash(metadataBytes) };
}

/** Require every reported disk-use class to be empty, including builder cache. */
export function assertEmptyStore(rows: { Type: string; TotalCount: string }[]): void {
  checked("store-types", () =>
    assert.deepEqual(rows.map((row) => row.Type).sort(), [
      "Build Cache",
      "Containers",
      "Images",
      "Local Volumes",
    ]),
  );
  const classes: Record<string, Reason> = {
    Images: "store-images",
    Containers: "store-containers",
    "Local Volumes": "store-volumes",
    "Build Cache": "store-build-cache",
  };
  for (const row of rows)
    checked(classes[row.Type] ?? "unknown", () =>
      assert.equal(String(row.TotalCount), "0", "Recipient store is not empty"),
    );
}
export function assertDistinctStores(builder: Daemon, recipient: Daemon): void {
  checked("same-id", () =>
    assert.notEqual(builder.id, recipient.id, "Recipient daemon is the builder"),
  );
  checked("same-root", () =>
    assert.notEqual(builder.root, recipient.root, "Recipient store is the builder store"),
  );
  checked("same-socket", () =>
    assert.notEqual(builder.host, recipient.host, "Recipient API is the builder API"),
  );
  checked("same-process", () =>
    assert.ok(
      builder.pid !== recipient.pid || builder.start !== recipient.start,
      "Recipient process is the builder",
    ),
  );
  if (recipient.rootless)
    checked("same-namespace", () =>
      assert.notEqual(
        builder.networkNamespace,
        recipient.networkNamespace,
        "Rootless recipient namespace is the builder namespace",
      ),
    );
}

/** Save-by-ID need not restore a tag; select only the sole image in the empty store. */
export function singleImportedImage(ids: string[]): string {
  checked(ids.length === 0 ? "empty-ids" : "id-count", () =>
    assert.ok(ids.length > 0 && ids.length <= 8, "Missing or ambiguous imported images"),
  );
  for (const id of ids)
    checked(ids.length === 1 && id === "" ? "empty-ids" : "id-format", () =>
      assert.match(id, digestPattern),
    );
  const unique = [...new Set(ids)];
  checked("multiple-ids", () => assert.equal(unique.length, 1, "Multiple imported images"));
  const id = unique[0];
  assert.ok(id);
  return id;
}

// Docker inspect can expose inert API defaults absent from OCI Config.
function configuration(config: ImageConfig): unknown {
  checked("runtime-config", () => assertRuntimeConfig(config));
  const keys = [
    "Env",
    "User",
    "WorkingDir",
    "Entrypoint",
    "Cmd",
    "StopSignal",
    "ExposedPorts",
    "Shell",
    "Volumes",
    "Labels",
  ];
  for (const [key, value] of Object.entries(config)) {
    if (keys.includes(key)) continue;
    checked("config-fields", () =>
      assert.ok(
        (["Hostname", "Domainname", "Image"].includes(key) && value === "") ||
          ([
            "AttachStdin",
            "AttachStdout",
            "AttachStderr",
            "Tty",
            "OpenStdin",
            "StdinOnce",
            "ArgsEscaped",
            "NetworkDisabled",
          ].includes(key) &&
            value === false) ||
          (["OnBuild", "Healthcheck"].includes(key) &&
            (value === null || (key === "OnBuild" && Array.isArray(value) && value.length === 0))),
        "Unexpected recipient configuration field",
      ),
    );
  }
  return {
    Env: config.Env,
    User: config.User,
    WorkingDir: config.WorkingDir,
    Entrypoint: config.Entrypoint,
    Cmd: config.Cmd ?? [],
    StopSignal: config.StopSignal,
    ExposedPorts: config.ExposedPorts,
    Shell: config.Shell ?? ["/bin/sh", "-c"],
    Volumes: config.Volumes ?? {},
    Labels: config.Labels ?? {},
  };
}
export function assertImportedImage(
  actual: Inspection,
  expected: { saved: SavedImage; configuration: ImageConfig; diffIds: string[] },
): string {
  checked("id-format", () => assert.match(actual.Id, digestPattern));
  checked("graph-id", () =>
    assert.ok(
      [expected.saved.manifest.digest, expected.saved.config.digest].includes(actual.Id),
      "Imported identity is outside the selected graph",
    ),
  );
  checked("os", () => assert.equal(actual.Os, "linux"));
  checked("arch", () => assert.equal(actual.Architecture, "amd64"));
  checked("rootfs", () => assert.equal(actual.RootFS.Type, "layers"));
  checked("diffids", () =>
    assert.deepEqual(actual.RootFS.Layers, expected.diffIds, "Imported DiffIDs changed"),
  );
  const actualConfig = configuration(actual.Config);
  const expectedConfig = configuration(expected.configuration);
  checked("config-equality", () =>
    assert.deepEqual(actualConfig, expectedConfig, "Imported runtime config changed"),
  );
  return actual.Id;
}

export function assertRecipientTag(actualId: string, expectedId: string): void {
  checked("tag", () => assert.equal(actualId, expectedId));
}
export function assertRecipientPostBinding(actual: Daemon, expected: Daemon): void {
  checked("postbinding", () => assert.deepEqual(actual, expected));
}

async function binding(): Promise<Daemon> {
  assert.equal(process.platform, "linux", "Recipient proof requires Linux");
  assert.match(
    env.DOCKER_HOST ?? "",
    /^unix:\/\/\/tmp\/fortipi-docker-[A-Za-z0-9_-]+\/docker.sock$/,
  );
  const socket = (env.DOCKER_HOST ?? "").slice("unix://".length);
  const session = dirname(socket);
  assert.equal(await realpath(session), session);
  assert.equal(env.DOCKER_CONFIG, resolve(session, "config"));
  for (const path of [session, env.DOCKER_CONFIG]) {
    const stat = await lstat(path);
    assert.ok(
      stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700,
    );
  }
  const pidText = (await readFile(resolve(session, "daemon.pid"), "utf8")).trim();
  assert.match(pidText, /^[1-9][0-9]*$/);
  const pid = Number(pidText);
  const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  const rootless = args.includes("--rootless");
  const executable = rootless
    ? await realpath(`/proc/${pid}/exe`)
    : await command("/usr/bin/sudo", ["-n", "/usr/bin/readlink", "-f", `/proc/${pid}/exe`]);
  const tool = dirname(executable);
  assert.ok(
    tool.startsWith(
      resolve(repository, `dist/toolchain/docker-${rootless ? "rootless" : "rootful"}-`),
    ),
  );
  assert.equal(executable, resolve(tool, "dockerd"));
  assert.equal(await realpath(tool), tool);
  const tools = await lstat(tool);
  assert.ok(
    tools.isDirectory() && tools.uid === process.getuid?.() && (tools.mode & 0o777) === 0o700,
  );
  assert.equal(
    (env.PATH ?? "")
      .split(delimiter)
      .find((path) => path.startsWith(resolve(repository, "dist/toolchain/docker-"))),
    tool,
  );
  const policy = JSON.parse(
    await readFile(resolve(repository, "tools/unstale/platform-tools.json"), "utf8"),
  ) as { docker: { sha256: string; version: string } };
  const raw = await readFile(resolve(repository, "dist/toolchain/docker-29.9.3.tgz"));
  assert.equal(hash(raw), policy.docker.sha256);
  const publisher = archiveEntries(raw);
  for (const name of ["docker", "dockerd"]) {
    const bytes = publisher.get(`docker/${name}`);
    assert.ok(bytes);
    assert.equal(await digest(resolve(tool, name)), hash(bytes));
  }
  const expected = [
    executable,
    ...(rootless ? ["--rootless", "--storage-driver", "overlay2"] : ["--dns", "172.17.0.1"]),
    "--config-file",
    resolve(session, "config/daemon.json"),
    "--log-level",
    "error",
    "--metrics-addr=",
    "--host",
    env.DOCKER_HOST,
    "--data-root",
    resolve(session, "data"),
    "--exec-root",
    resolve(session, "exec"),
    "--pidfile",
    resolve(session, "daemon.pid"),
  ];
  assert.deepEqual(args, expected, "Recipient daemon private binding changed");
  assert.equal(await readFile(resolve(session, "config/daemon.json"), "utf8"), "{}\n");
  const api = await lstat(socket);
  assert.ok(
    api.isSocket() && api.uid === (rootless ? process.getuid?.() : 0) && (api.mode & 7) === 0,
  );
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const uid = rootless ? process.getuid?.() : 0;
  assert.ok(
    /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/m
      .exec(status)
      ?.slice(1)
      .every((value) => Number(value) === uid),
  );
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  assert.ok(start && /^[0-9]+$/.test(start));
  const info = JSON.parse(
    await docker([
      "info",
      "--format",
      '{"id":{{json .ID}},"root":{{json .DockerRootDir}},"version":{{json .ServerVersion}}}',
    ]),
  ) as { id: string; root: string; version: string };
  assert.match(info.id, /^[A-Za-z0-9:-]{1,128}$/);
  assert.equal(info.version, policy.docker.version);
  assert.equal(info.root, resolve(session, "data"));
  // Root-owned stores require sudo only for the canonical-path query, never a listing.
  const canonical = rootless
    ? await realpath(info.root)
    : await command("/usr/bin/sudo", ["-n", "/usr/bin/readlink", "-f", info.root]);
  assert.equal(canonical, info.root);
  const namespace = `/proc/${pid}/ns/net`;
  const networkNamespace = rootless
    ? await readlink(namespace)
    : await command("/usr/bin/sudo", ["-n", "/usr/bin/readlink", namespace]);
  assert.match(networkNamespace, /^net:\[[0-9]+\]$/);
  return {
    id: info.id,
    root: canonical,
    host: `unix://${await realpath(socket)}`,
    pid,
    start,
    rootless,
    networkNamespace,
  };
}
async function readReceipt(): Promise<Receipt> {
  const stat = await lstat(receiptPath);
  assert.ok(
    stat.isFile() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o777) === 0o600 &&
      stat.size < 16384,
  );
  const value = JSON.parse(await readFile(receiptPath, "utf8")) as Receipt;
  assert.equal(value.version, 1);
  return value;
}
function matchSource(receipt: Receipt, source: Awaited<ReturnType<typeof sourceProof>>) {
  assert.equal(receipt.sourceCommit, source.metadata.sourceCommit);
  assert.equal(receipt.archiveSha256, source.metadata.archiveSha256);
  assert.equal(receipt.metadataSha256, source.metadataSha256);
}
async function inspection(reference = imageTag): Promise<Inspection> {
  return JSON.parse(
    await docker([
      "image",
      "inspect",
      reference,
      "--format",
      '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"RootFS":{{json .RootFS}},"Config":{{json .Config}}}',
    ]),
  ) as Inspection;
}

async function loadArchive(expectedSha256: string): Promise<void> {
  const bytes = createHash("sha256");
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes.update(chunk);
      callback(null, chunk);
    },
  });
  const child = spawn("docker", ["image", "load", "--platform", "linux/amd64", "--quiet"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 120000);
  const exit = new Promise<void>((accept, reject) => {
    child.once("error", () => reject(new Error("Recipient import process failed")));
    child.once("close", (code) =>
      code === 0 ? accept() : reject(new Error("Recipient import failed")),
    );
  });
  try {
    await Promise.all([
      pipeline(createReadStream(resolve(directory, "image.tar")), meter, child.stdin),
      exit,
    ]);
    assert.equal(
      bytes.digest("hex"),
      expectedSha256,
      "Imported stream differs from canonical archive",
    );
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

/** The fixture must stay on the recipient daemon and its imported selected image. */
export async function verifyRecipientFixture(): Promise<string> {
  try {
    const receipt = await readReceipt();
    assert.equal(receipt.phase, "loaded", "Recipient import proof is required");
    const source = await sourceProof();
    matchSource(receipt, source);
    const current = await binding();
    assert.deepEqual(current, receipt.recipient, "Fixture daemon differs from imported recipient");
    assertDistinctStores(receipt.builder, current);
    if (current.rootless) {
      assert.ok(process.argv.includes("--require-fuse"), "Rootless recipient requires real FUSE");
      assert.equal(await readlink("/proc/self/ns/net"), current.networkNamespace);
      assert.equal(
        await readlink("/proc/self/ns/user"),
        await readlink(`/proc/${current.pid}/ns/user`),
      );
    }
    const imageId = assertImportedImage(await inspection(), source.graph);
    assert.equal(imageId, receipt.imageId, "Recipient fixture image changed");
    return imageId;
  } catch {
    throw new Error("Recipient import fixture binding failed");
  }
}

async function main(): Promise<void> {
  let stage: Stage = "prerequisite";
  let reason: Reason = "prerequisite";
  try {
    assert.equal(process.platform, "linux");
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    assert.ok(process.argv.length === 3 && ["capture", "load"].includes(process.argv[2] ?? ""));
    await command("/usr/bin/systemctl", ["is-active", "--quiet", "agent.service"]);
    stage = "source-audit";
    reason = "source-audit";
    const source = await sourceProof();
    stage = "docker-binding";
    reason = "docker-binding";
    const current = await binding();
    if (process.argv[2] === "capture") {
      stage = "builder-idle";
      reason = "builder-idle";
      assert.equal(
        await docker(["container", "ls", "--all", "--quiet"]),
        "",
        "Builder has containers; no cleanup is authorized",
      );
      assert.equal((await inspection()).Id, source.metadata.imageId);
      const receipt: Receipt = {
        version: 1,
        phase: "builder",
        sourceCommit: source.metadata.sourceCommit,
        metadataSha256: source.metadataSha256,
        archiveSha256: source.metadata.archiveSha256,
        builder: current,
      };
      await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    } else {
      stage = "recipient-empty";
      reason = "receipt";
      const receipt = await readReceipt();
      reason = "receipt-phase";
      assert.equal(receipt.phase, "builder");
      reason = "source-match";
      matchSource(receipt, source);
      assertDistinctStores(receipt.builder, current);
      reason = "store-query";
      const diskUsage = await docker(["system", "df", "--format", "{{json .}}"]);
      reason = "store-types";
      assertEmptyStore(diskUsage.split("\n").map((line) => JSON.parse(line)));
      stage = "import";
      reason = "import";
      await loadArchive(source.metadata.archiveSha256);
      stage = "imported-identity";
      reason = "image-list";
      const selected = singleImportedImage(
        (await docker(["image", "ls", "--all", "--quiet", "--no-trunc"])).split("\n"),
      );
      reason = "image-inspect";
      const imageId = assertImportedImage(await inspection(selected), source.graph);
      reason = "tag";
      await docker(["image", "tag", imageId, imageTag]);
      assertRecipientTag((await inspection()).Id, imageId);
      reason = "postbinding";
      assertRecipientPostBinding(await binding(), current);
      reason = "archive-stability";
      assert.equal(await digest(resolve(directory, "image.tar")), source.metadata.archiveSha256);
      reason = "metadata-stability";
      assert.equal(await digest(resolve(directory, "image-metadata.json")), source.metadataSha256);
      reason = "receipt-stability";
      assert.deepEqual(await readReceipt(), receipt, "Recipient capture receipt changed");
      reason = "receipt-write";
      await writeFile(
        receiptPath,
        `${JSON.stringify({ ...receipt, phase: "loaded", recipient: current, imageId })}\n`,
        { mode: 0o600 },
      );
    }
    console.log(
      JSON.stringify({
        probe: "recipient-import",
        phase: process.argv[2],
        passed: true,
        archiveSha256: source.metadata.archiveSha256,
      }),
    );
  } catch (error) {
    console.error(JSON.stringify(recipientFailure(stage, error, reason)));
    process.exitCode = 1;
  }
}
if (import.meta.main) await main();
