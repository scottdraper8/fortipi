// CI boundary only. The CLI owner supplies both installed-consumer proof ports.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readDistributionReceipt } from "../packages/fortipi-cli/test/offline-consumer.ts";

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
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
let diagnosticSources: readonly string[] = [];
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
      file === process.execPath &&
      args[0] === "packages/fortipi-cli/test/install-harness.ts" &&
      error instanceof Error &&
      "stderr" in error
    ) {
      const code = "code" in error && typeof error.code === "number" ? error.code : null;
      const signal =
        "signal" in error &&
        ["SIGKILL", "SIGTERM", "SIGABRT", "SIGSEGV"].includes(String(error.signal))
          ? String(error.signal)
          : "none";
      const stderr =
        typeof error.stderr === "string"
          ? error.stderr
          : Buffer.isBuffer(error.stderr)
            ? error.stderr.toString("utf8")
            : "";
      const stdoutBytes =
        "stdout" in error && (typeof error.stdout === "string" || Buffer.isBuffer(error.stdout))
          ? Buffer.byteLength(error.stdout)
          : 0;
      // This fixed installer runs only with onlineEnv(): no deployment,
      // application, registry or GitHub credentials are present. Preserve its
      // bounded tool diagnostic; signed URL queries and auth-shaped values
      // are still removed. Other subprocess failures never emit captured text.
      process.stderr.write(
        stderr
          .slice(0, 8192)
          .replace(/https?:\/\/[^\s"'<>]+/g, "[URL removed]")
          .replace(
            /(?:Bearer\s+|(?:token|password|secret|authorization)\s*[=:]\s*)[^\s"',;]+/gi,
            "[authentication removed]",
          ),
      );
      const condition =
        [
          "ERR_ASSERTION",
          "ERR_MODULE_NOT_FOUND",
          "ERR_PACKAGE_PATH_NOT_EXPORTED",
          "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
          "ERR_UNKNOWN_BUILTIN_MODULE",
          "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          "ENOENT",
          "EACCES",
          "ENOSPC",
          "ENOMEM",
          "SyntaxError",
          "TypeError",
          "ReferenceError",
          "RangeError",
        ].find((known) => stderr.includes(known) || ("code" in error && error.code === known)) ??
        "unknown";
      failure = `${installedFailureLocation(stderr, diagnosticSources)}; exit=${code}; signal=${signal}; stderrBytes=${Buffer.byteLength(stderr)}; stdoutBytes=${stdoutBytes}; kind=${condition}`;
    }
    throw error;
  }
}

/** Only static repository locations are diagnostic output; discard all values,
 * URLs, request bodies and arbitrary exception messages from library stderr. */
export function installedFailureLocation(
  stderr: unknown,
  trackedSources: readonly string[] = [],
): string {
  const allowed = new Set(trackedSources);
  const locations =
    typeof stderr === "string"
      ? (
          stderr.match(
            /(?:scripts|packages|tests|apps)\/[\w./-]+\.(?:ts|js):\d{1,6}(?::\d{1,6})?/g,
          ) ?? []
        ).filter(
          (location) =>
            allowed.has(location.replace(/:\d+(?::\d+)?$/, "")) ||
            /^(?:scripts\/(?:prepare-release|rewrite-publish-names|runtime-closure|runtime-conveyance|check-licenses|generate-notices|stage-runtime-bundle|verify-release-gates|pnpm-executable)\.ts|scripts\/test\/release\/fixtures\.ts|packages\/fortipi-cli\/(?:dist|test)\/[a-z.-]+\.(?:ts|js)):/.test(
              location,
            ),
        )
      : [];
  const selected = [...new Set(locations)].slice(0, 4);
  return `scoped component failed${selected.length ? ` at ${selected.join(",")}` : " before a known source frame"}`;
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
  diagnosticSources = (await git("ls-files", "--", "*.ts", "*.js")).split("\n");
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
async function image() {
  const temporary = process.env.RUNNER_TEMP;
  assert.ok(temporary && isAbsolute(temporary), "Actual runner temporary directory required");
  const { prepareImage } = await import("./prepare-release.ts");
  await prepareImage(join(temporary, "image-reference.json"), join(temporary, "qualified-image"));
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
  const receipt = await readDistributionReceipt(receiptPath);
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
      componentOnly: true,
      publishable: false,
      scope: receipt.scope,
      packageName: receipt.packageName,
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
    const label = ["inputs", "image", "install", "offline", "namespace"].includes(phase ?? "")
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
