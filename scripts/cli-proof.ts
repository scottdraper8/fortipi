// CI boundary only. The CLI owner supplies both installed-consumer proof ports.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { materializeSourceKitInventory } from "./image-source-distribution.ts";

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const imageSource = "ad053471b6dce3e3e666cc070c623090ac11925d";
const imageRun = 43144678762;
const imageArtifact = 13910344388;
const imageHash = "8a59a497b45ebc8125282e7766744ccbc603aed96faba0d4158217c86ff55092";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inside = (parent: string, path: string) => path.startsWith(`${parent}${sep}`);
type OwnerPort = "install-harness" | "offline-consumer" | "notices";
type HostTool = "unshare" | "mount" | "setpriv" | "unzip" | "ip";
const hostTools: Record<HostTool, string> = {
  unshare: "/usr/bin/unshare",
  mount: "/usr/bin/mount",
  setpriv: "/usr/bin/setpriv",
  unzip: "/usr/bin/unzip",
  ip: "/usr/sbin/ip",
};
type InputGate =
  | `eligibility.${
      | "platform"
      | "node"
      | "actions"
      | "branch"
      | "source-sha"
      | "checkout-sha"
      | "tracked-clean"
      | "pnpm"
      | "hardener"}`
  | `inputs.owner.${OwnerPort}.${"file" | "tracked"}`
  | `inputs.host.${HostTool}`;
let gate: InputGate | "phase" = "phase";
let failure = "eligibility or required input";
function inputGate(value: InputGate) {
  gate = value;
  failure = "guard";
}
const onlineEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    CI: "true",
    LANG: "C",
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    npm_config_build_from_source: "true",
  };
  for (const key of ["PATH", "PYTHON", "pythonLocation", "npm_config_node_gyp"])
    if (process.env[key]) env[key] = process.env[key];
  return env;
};
async function run(file: string, args: string[], cwd = root, timeout = 120000) {
  try {
    return await execute(file, args, {
      cwd,
      env: onlineEnv(),
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    failure = `subprocess ${basename(file)} failed`;
    if (
      args[0] === "apps/worker/container/build.ts" &&
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.includes("Signed image dependency/source closure drift")
    )
      failure = "signed image dependency/source closure drift; qualified context not recreated";
    throw error;
  }
}
const git = async (...args: string[]) => (await run("git", args)).stdout.trim();
async function regular(path: string) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) failure = "symbolic-link";
  else if (!stat.isFile()) failure = "non-regular-file";
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Required regular proof input is absent");
}
// Only the fixed hostTools map uses this policy; repository ports keep regular().
export async function canonicalHostExecutable(alias: string): Promise<string> {
  const previous = failure;
  const path = await realpath(alias);
  failure = "host-tool-outside-system-prefix";
  assert.ok(
    ["/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/"].some((prefix) => path.startsWith(prefix)),
  );
  failure = "host-tool-untrusted-directory";
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const stat = await lstat(directory);
    assert.ok(stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o022) === 0);
    if (directory === "/") break;
  }
  failure = "host-tool-untrusted-file";
  const stat = await lstat(path);
  assert.ok(
    stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0 && (stat.mode & 0o111) !== 0,
  );
  await access(path, constants.X_OK);
  failure = previous;
  return path;
}
const hostTool = (name: HostTool) => canonicalHostExecutable(hostTools[name]);
async function eligible() {
  inputGate("eligibility.platform");
  assert.equal(process.platform, "linux", "Proof requires actual Linux before any home lookup");
  inputGate("eligibility.node");
  assert.equal(process.versions.node, "26.13.1");
  inputGate("eligibility.actions");
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Only the dedicated Actions boundary is eligible",
  );
  inputGate("eligibility.branch");
  assert.match(process.env.GITHUB_REF ?? "", /^refs\/heads\/ci\/fortipi-cli-proof-[\w.-]+$/);
  inputGate("eligibility.source-sha");
  assert.match(process.env.SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
  inputGate("eligibility.checkout-sha");
  assert.equal(await git("rev-parse", "HEAD"), process.env.SOURCE_SHA);
  inputGate("eligibility.tracked-clean");
  assert.equal((await run("git", ["status", "--porcelain", "--untracked-files=no"])).stdout, "");
  inputGate("eligibility.pnpm");
  assert.equal((await run("pnpm", ["--version"], tmpdir())).stdout.trim(), "12.18.0");
  inputGate("eligibility.hardener");
  await run("/usr/bin/systemctl", ["is-active", "--quiet", "agent.service"]);
  gate = "phase";
  failure = "phase guard or required input";
}
function distribution() {
  const directory = process.env.RUNNER_TEMP;
  assert.ok(directory && isAbsolute(directory), "Actual runner temporary directory required");
  return join(directory, "fortipi-cli-distribution");
}
async function inputs() {
  for (const [port, path] of [
    ["install-harness", "packages/fortipi-cli/test/install-harness.ts"],
    ["offline-consumer", "packages/fortipi-cli/test/offline-consumer.ts"],
    ["notices", "scripts/generate-notices.ts"],
  ] as const) {
    inputGate(`inputs.owner.${port}.file`);
    await regular(join(root, path));
    inputGate(`inputs.owner.${port}.tracked`);
    await git("ls-files", "--error-unmatch", path);
  }
  for (const name of ["unshare", "mount", "setpriv", "unzip", "ip"] as const) {
    inputGate(`inputs.host.${name}`);
    await hostTool(name);
  }
  gate = "phase";
  failure = "phase guard or required input";
}
async function bounded(response: Response, maximum: number) {
  assert.ok(response.body, "Required producer response has no body");
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(parts);
      size += next.value.length;
      assert.ok(size <= maximum, "Producer response exceeds the proof input bound");
      parts.push(Buffer.from(next.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function image() {
  const repository = process.env.GITHUB_REPOSITORY;
  assert.match(repository ?? "", /^[\w.-]+\/[\w.-]+$/);
  const token = process.env.GH_TOKEN;
  assert.ok(token, "Read-only Actions token is required only for the qualified artifact");
  const api = `https://api.github.com/repos/${repository}`;
  const get = async (path: string) => {
    const response = await fetch(`${api}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    return response;
  };
  const runResponse = await get(`/actions/runs/${imageRun}`);
  assert.equal(runResponse.status, 200, "Qualified producer run is unavailable");
  const producer = JSON.parse((await bounded(runResponse, 262144)).toString());
  assert.equal(producer.head_sha, imageSource);
  assert.equal(producer.repository.full_name, repository);
  assert.equal(producer.conclusion, "success");
  const infoResponse = await get(`/actions/artifacts/${imageArtifact}`);
  assert.equal(infoResponse.status, 200, "Qualified producer artifact is unavailable");
  const info = JSON.parse((await bounded(infoResponse, 65536)).toString());
  assert.equal(info.id, imageArtifact);
  assert.equal(info.name, `container-evidence-rootless-${imageSource}`);
  assert.equal(info.expired, false);
  assert.equal(info.workflow_run.id, imageRun);
  assert.equal(info.workflow_run.head_sha, imageSource);
  assert.ok(info.size_in_bytes > 0 && info.size_in_bytes <= 65536);
  const download = await get(`/actions/artifacts/${imageArtifact}/zip`);
  assert.equal(download.status, 302, "Producer artifact redirect is required");
  const location = new URL(download.headers.get("Location") ?? "");
  assert.ok(
    location.protocol === "https:" &&
      !location.username &&
      !location.password &&
      (!location.port || location.port === "443") &&
      (location.hostname.endsWith(".blob.core.windows.net") ||
        location.hostname.endsWith(".actions.githubusercontent.com")),
    "Unexpected artifact storage origin",
  );
  // The GitHub token is never forwarded to the signed storage URL or a child.
  const archive = await fetch(location, { redirect: "error", signal: AbortSignal.timeout(30000) });
  assert.equal(archive.status, 200, "Qualified artifact bytes are unavailable");
  const directory = await mkdtemp(join(tmpdir(), "fortipi-cli-image-"));
  try {
    const path = join(directory, "metadata.zip");
    await writeFile(path, await bounded(archive, 65536), { flag: "wx" });
    const unzip = await hostTool("unzip");
    const entries = (await run(unzip, ["-Z1", path])).stdout.trim().split("\n");
    assert.ok(entries.length <= 32 && entries.every((entry) => !entry.split("/").includes("..")));
    const names = entries.filter((entry) => /(^|\/)image-metadata\.json$/.test(entry));
    assert.equal(names.length, 1, "One actual image metadata entry is required");
    const bytes = Buffer.from((await run(unzip, ["-p", path, names[0] ?? ""])).stdout);
    assert.equal(sha256(bytes), imageHash, "Parent-qualified metadata bytes changed");
    const metadata = JSON.parse(bytes.toString());
    assert.equal(metadata.sourceCommit, imageSource);
    assert.equal(metadata.runtimeVerified, false);
    assert.equal(metadata.licenseReviewRequired, true);
    assert.equal(metadata.registryDigest, null);
    await mkdir(join(root, "apps/worker/dist/container"), { recursive: true });
    await writeFile(join(root, "apps/worker/dist/container/image-metadata.json"), bytes, {
      flag: "wx",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function context() {
  await git("diff", "--exit-code", imageSource, "HEAD", "--", "apps/worker/container");
  const directory = await mkdtemp(join(tmpdir(), "fortipi-cli-ad-context-"));
  const checkout = join(directory, "source");
  await git("worktree", "add", "--detach", checkout, imageSource);
  try {
    await run(process.execPath, ["scripts/install-dependencies.ts"], checkout, 600000);
    await run("pnpm", ["--dir", "tools/unstale", "install", "--frozen-lockfile"], checkout);
    await run(process.execPath, ["apps/worker/container/build.ts", "--prepare"], checkout, 1200000);
    const source = join(checkout, "apps/worker/dist/container");
    const target = join(root, "apps/worker/dist/container");
    const metadata = JSON.parse(await readFile(join(target, "image-metadata.json"), "utf8"));
    failure = "reconstructed qualified AD source kit differs from image evidence";
    assert.equal(
      sha256(await readFile(join(source, "sources-and-notices.tar"))),
      metadata.sourceKitSha256,
    );
    failure = "qualified context/support input copy";
    for (const path of ["context", "source-revision.json", "sources-and-notices.tar"])
      await cp(join(source, path), join(target, path), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    await materializeSourceKitInventory(
      { kit: join(target, "sources-and-notices.tar"), kitSha256: metadata.sourceKitSha256 },
      join(target, "source-kit-inventory.json"),
    );
  } finally {
    await git("worktree", "remove", "--force", checkout);
    await rm(directory, { recursive: true, force: true });
  }
}
interface Receipt {
  schemaVersion: number;
  consumer: string;
  checkout: string;
  checkoutUid: number;
  sourceCommit: string;
  assetManifestSha256: string;
  parentNetworkNamespace: string;
  strictInstalledConsumer: boolean;
  readOnlyInstall: boolean;
  installedPrepare: boolean;
}
interface Boundary {
  consumer: string;
  receipt: string;
  checkout: string;
  bridge: string;
  userHome: string;
  uid: number;
  gid: number;
}
async function namespace(boundary: Boundary) {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid?.(), 0);
  assert.match(boundary.bridge, /^\/opt\/fortipi-cli-proof-[0-9-]+$/);
  assert.match(boundary.userHome, /^\/home\/fortipi-cli-proof-[0-9-]+$/);
  process.chdir("/");
  const mountPath = await hostTool("mount");
  const mount = (args: string[]) => run(mountPath, args, "/");
  const bind = async (source: string, target: string, readonly = true) => {
    await mkdir(dirname(target), { recursive: true });
    const stat = await lstat(source);
    if (stat.isDirectory()) await mkdir(target, { recursive: true });
    else await writeFile(target, "");
    await mount(["--bind", source, target]);
    if (readonly) await mount(["-o", "remount,bind,ro,nosuid,nodev", target]);
  };
  await mount(["--make-rprivate", "/"]);
  await run(await hostTool("ip"), ["link", "set", "lo", "up"], "/");
  await bind(boundary.consumer, join(boundary.bridge, "consumer"));
  await bind(boundary.userHome, join(boundary.bridge, "user-home"), false);
  // Mask host homes, caches, sockets and checkout only in this private mount namespace.
  for (const [path, mode] of [
    ["/home", "0755"],
    ["/root", "0000"],
    ["/tmp", "1777"],
    ["/var/tmp", "1777"],
    ["/run", "0755"],
    [boundary.checkout, "0000"],
  ]) {
    assert.ok(path && mode);
    await mkdir(path, { recursive: true });
    await mount(["-t", "tmpfs", "-o", `mode=${mode},nosuid,nodev`, "tmpfs", path]);
  }
  await bind(join(boundary.bridge, "consumer"), boundary.consumer);
  await bind(join(boundary.bridge, "distribution.json"), boundary.receipt);
  await bind(join(boundary.bridge, "user-home"), boundary.userHome, false);
  const env: NodeJS.ProcessEnv = {
    PATH: `${boundary.bridge}/bin:${boundary.bridge}/pnpm/node_modules/.bin:/usr/bin:/bin`,
    LANG: "C",
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  };
  const result = await execute(
    await hostTool("setpriv"),
    [
      `--reuid=${boundary.uid}`,
      `--regid=${boundary.gid}`,
      "--clear-groups",
      "--no-new-privs",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      join(boundary.bridge, "bin/node"),
      join(boundary.consumer, "offline-consumer.ts"),
      boundary.receipt,
    ],
    { cwd: boundary.consumer, env, timeout: 300000, maxBuffer: 65536 },
  );
  process.stdout.write(result.stdout);
}
async function offline() {
  const staging = distribution();
  const receiptPath = join(staging, "distribution.json");
  const bytes = await readFile(receiptPath);
  const receipt = JSON.parse(bytes.toString()) as Receipt;
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.checkout, await realpath(root));
  assert.equal(receipt.checkoutUid, (await lstat(root)).uid);
  assert.equal(receipt.consumer, join(staging, "consumer"));
  assert.equal(receipt.sourceCommit, process.env.SOURCE_SHA);
  assert.equal(receipt.parentNetworkNamespace, await readlink("/proc/self/ns/net"));
  assert.ok(receipt.strictInstalledConsumer && receipt.readOnlyInstall && receipt.installedPrepare);
  assert.match(receipt.assetManifestSha256, /^[a-f0-9]{64}$/);
  const runId = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  assert.match(runId, /^[0-9]+-[0-9]+$/);
  const user = `fortipi-cli-proof-${runId}`;
  assert.ok(user.length <= 32, "Dedicated OS account name exceeds the platform bound");
  const userHome = `/home/${user}`;
  const bridge = `/opt/${user}`;
  const sudo = (file: string, args: string[]) => run("/usr/bin/sudo", ["-n", file, ...args]);
  await sudo("/usr/sbin/useradd", [
    "--no-create-home",
    "--user-group",
    "--home-dir",
    userHome,
    "--shell",
    "/usr/sbin/nologin",
    user,
  ]);
  try {
    const account = (await run("/usr/bin/getent", ["passwd", user])).stdout.trim().split(":");
    assert.equal(account[5], userHome);
    const uid = Number(account[2]),
      gid = Number(account[3]);
    assert.ok(uid > 0 && uid !== receipt.checkoutUid && Number.isSafeInteger(gid));
    await sudo("/usr/bin/install", [
      "-d",
      "-m",
      "0700",
      "-o",
      String(uid),
      "-g",
      String(gid),
      userHome,
    ]);
    await sudo("/usr/bin/install", ["-d", "-m", "0755", join(bridge, "bin"), join(bridge, "pnpm")]);
    await sudo("/usr/bin/install", ["-m", "0555", process.execPath, join(bridge, "bin/node")]);
    await sudo("/usr/bin/install", ["-m", "0444", receiptPath, join(bridge, "distribution.json")]);
    const pnpm = process.env.FORTIPI_CLI_PROOF_PNPM;
    assert.ok(pnpm && isAbsolute(pnpm) && !inside(root, pnpm));
    const pnpmBin = process.env.FORTIPI_CLI_PROOF_PNPM_BIN;
    assert.ok(pnpmBin && inside(pnpm, pnpmBin));
    assert.equal(
      (await run(join(pnpmBin, "pnpm"), ["--version"], tmpdir())).stdout.trim(),
      "12.18.0",
    );
    await sudo("/usr/bin/cp", [
      "-a",
      join(pnpm, "node_modules"),
      join(bridge, "pnpm/node_modules"),
    ]);
    await sudo("/usr/bin/ln", [
      "-s",
      `../pnpm/${relative(pnpm, join(pnpmBin, "pnpm"))}`,
      join(bridge, "bin/pnpm"),
    ]);
    await chmod(receipt.consumer, 0o555);
    const boundary: Boundary = {
      consumer: receipt.consumer,
      receipt: receiptPath,
      checkout: root,
      bridge,
      userHome,
      uid,
      gid,
    };
    const result = await run(
      "/usr/bin/sudo",
      [
        "-n",
        await hostTool("unshare"),
        "--mount",
        "--net",
        "--pid",
        "--fork",
        "--mount-proc",
        "--kill-child",
        process.execPath,
        script,
        "namespace",
        JSON.stringify(boundary),
      ],
      "/",
      330000,
    );
    const proof = JSON.parse(result.stdout);
    for (const key of [
      "passed",
      "emptyOsHomeInitially",
      "dedicatedIdentity",
      "checkoutInaccessible",
      "networkNamespaceIsolated",
      "readOnlyInstall",
      "actualPinnedWranglerDryBuild",
    ])
      assert.equal(proof[key], true, "Required actual installed proof is missing");
    assert.equal(proof.sourceCommit, receipt.sourceCommit);
    assert.equal(proof.assetManifestSha256, receipt.assetManifestSha256);
    const evidence = {
      schemaVersion: 1,
      sourceCommit: receipt.sourceCommit,
      assetManifestSha256: receipt.assetManifestSha256,
      imageSource,
      imageRun,
      imageArtifact,
      imageMetadataSha256: imageHash,
      passed: true,
      emptyOsHomeInitially: true,
      dedicatedIdentity: true,
      checkoutInaccessible: true,
      networkNamespaceIsolated: true,
      readOnlyInstall: true,
      actualPinnedWranglerDryBuild: true,
    };
    await mkdir(join(root, "dist/cli-proof"), { recursive: true });
    await writeFile(
      join(root, "dist/cli-proof/evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx" },
    );
  } finally {
    await sudo("/usr/sbin/userdel", ["--remove", user]);
    await sudo("/usr/bin/rm", ["-rf", "--", bridge]);
  }
}
async function main() {
  const phase = process.argv[2];
  if (phase === "namespace") {
    assert.equal(process.argv.length, 4);
    await namespace(JSON.parse(process.argv[3] ?? ""));
    return;
  }
  await eligible();
  assert.equal(process.argv.length, 3);
  if (phase === "inputs") await inputs();
  else if (phase === "image") await image();
  else if (phase === "context") await context();
  else if (phase === "install") {
    await inputs();
    await run(
      process.execPath,
      ["packages/fortipi-cli/test/install-harness.ts", distribution()],
      root,
      600000,
    );
    await regular(join(distribution(), "distribution.json"));
    await regular(join(distribution(), "consumer/offline-consumer.ts"));
  } else if (phase === "offline") await offline();
  else throw new Error("Unknown proof phase");
}
if (import.meta.main)
  await main().catch((error: unknown) => {
    // Neither signed artifact URLs nor child auth/output can enter a diagnostic.
    const phase = process.argv[2];
    const label = ["inputs", "image", "context", "install", "offline", "namespace"].includes(
      phase ?? "",
    )
      ? phase
      : "unknown";
    const condition =
      error instanceof assert.AssertionError
        ? "assertion"
        : error instanceof Error &&
            "code" in error &&
            ["ENOENT", "EACCES", "ENOTDIR", "ELOOP"].includes(String(error.code))
          ? String(error.code)
          : "unclassified";
    process.stderr.write(
      `CLI proof ${label} failed closed: gate=${gate}; reason=${failure}; condition=${condition}\n`,
    );
    process.exitCode = 1;
  });
