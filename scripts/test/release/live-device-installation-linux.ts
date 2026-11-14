// TEST ONLY. Source-component provenance is deliberately substituted below.
// The production installer, imports, types, CLI/real Wrangler, reload and guards are not.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ArtifactReference, CandidateManifest } from "../../verify-release-gates.ts";

const script = fileURLToPath(import.meta.url);
const checkout = resolve(dirname(script), "../../..");
const execute = promisify(execFile);
const scope = "fortipi-ci-test";
const kind = "live-device-installation-source-component";
let phase = "eligibility";
const phases = [
  "eligibility",
  "namespace",
  "authenticate-existing-source-component",
  "dedicated-identity",
  "isolated-full-helper",
  "full-installed-setup",
  "reload-positive",
  "descriptor-extra-field",
  "candidate-substitution",
  "changed-installed-entry",
  "writable-installed-entry",
  "hardlinked-installed-entry",
  "restored-reload",
  "cleanup",
];
const diagnosticSources = [
  "scripts/live-device-installation.ts",
  "scripts/test/release/live-device-installation-linux.ts",
  "tests/distribution/install.ts",
  "tests/distribution/installed-inventory.ts",
  "tests/distribution/consumer-runtime.ts",
];
interface Binding {
  sourceCommit: string;
  candidateSha256: string;
  assetManifestSha256: string;
}
interface Boundary extends Binding {
  bridge: string;
  candidatePath: string;
  checkoutUid: number;
  uid: number;
  gid: number;
  userHome: string;
  githubActions: "true";
}

/** Never emit arbitrary library exception bodies, credentials or child environment. */
function condition(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^(?:ERR_[A-Z_]+|ENOENT|EACCES|EPERM|ENOSPC)$/.test(code)
    ? code
    : "component-operation-failed";
}
const publicEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C.UTF-8",
  CI: "true",
  WRANGLER_SEND_METRICS: "false",
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
});
async function run(file: string, args: string[], timeout = 120000, env = publicEnv()) {
  try {
    return await execute(file, args, { cwd: "/", env, timeout, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string")
      for (const line of stderr.split("\n")) {
        try {
          const status = JSON.parse(line) as Record<string, unknown>;
          if (
            status.kind !== kind ||
            status.componentOnly !== true ||
            status.passed !== false ||
            !phases.includes(String(status.phase)) ||
            !/^(?:ERR_[A-Z_]+|ENOENT|EACCES|EPERM|ENOSPC|component-operation-failed)$/.test(
              String(status.condition),
            )
          )
            continue;
          const { installedFailureLocation } = await import("../../cli-proof.ts");
          process.stderr.write(
            `${JSON.stringify({ kind, componentOnly: true, passed: false, phase: status.phase, condition: status.condition, location: installedFailureLocation(String(status.location ?? ""), diagnosticSources) })}\n`,
          );
        } catch {
          /* Arbitrary subprocess output is not a diagnostic port. */
        }
      }
    throw error;
  }
}
async function host(alias: string): Promise<string> {
  const { canonicalHostExecutable } = await import("../../cli-proof.ts");
  return canonicalHostExecutable(alias);
}

/** A test read seam, NOT an ArtifactReference/producer authentication capability.
 * The parent has independently run the clean-source archive reader before this binding exists.
 * Zero IDs are intentional: these data can never pass the genuine privileged reader. */
export function componentRead(
  binding: Binding,
  candidate: CandidateManifest,
  hash: string,
  reference: ArtifactReference,
): void {
  assert.equal(candidate.publishable, false);
  assert.equal(candidate.scope, scope);
  assert.equal(candidate.sourceCommit, binding.sourceCommit);
  assert.equal(candidate.assetManifestSha256, binding.assetManifestSha256);
  assert.equal(hash, binding.candidateSha256);
  assert.deepEqual(reference, componentReference(binding));
  assert.deepEqual(
    [candidate.producer.workflowId, candidate.producer.runId, candidate.producer.runAttempt],
    [0, 0, 0],
  );
}
function componentReference(binding: Binding): ArtifactReference {
  return {
    runId: 0,
    runAttempt: 0,
    artifactId: 0,
    artifactName: kind,
    artifactDigest: `sha256:${binding.candidateSha256}`,
    candidateSha256: binding.candidateSha256,
  };
}
async function frame(path: string): Promise<Boundary> {
  assert.match(path, /^\/opt\/fortipi-device-proof-[0-9]+-[0-9]+\/frame\.json$/);
  const stat = await lstat(path);
  assert.ok(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.uid === 0 &&
      stat.size <= 8192,
  );
  assert.equal(stat.mode & 0o222, 0);
  const value = JSON.parse(await readFile(path, "utf8")) as Boundary;
  assert.deepEqual(Object.keys(value).sort(), [
    "assetManifestSha256",
    "bridge",
    "candidatePath",
    "candidateSha256",
    "checkoutUid",
    "gid",
    "githubActions",
    "sourceCommit",
    "uid",
    "userHome",
  ]);
  assert.equal(value.bridge, dirname(path));
  assert.equal(value.candidatePath, join(value.bridge, "component/candidate.json"));
  assert.match(value.sourceCommit, /^[a-f0-9]{40}$/);
  for (const hash of [value.candidateSha256, value.assetManifestSha256])
    assert.match(hash, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(value.uid) && value.uid > 0 && value.uid !== value.checkoutUid);
  assert.ok(Number.isSafeInteger(value.gid) && value.gid > 0);
  assert.match(value.userHome, /^\/home\/fortipi-device-[0-9]+-[0-9]+$/);
  assert.equal(value.githubActions, "true");
  return value;
}
async function installReadSeam(binding: Boundary) {
  assert.ok(process.execArgv.includes("--experimental-test-module-mocks"));
  assert.equal(process.env.GITHUB_ACTIONS, binding.githubActions); // Real parent context, never a false/local mode flag.
  assert.equal(process.env.GITHUB_TOKEN, undefined);
  assert.equal(
    process.env.FORTIPI_CANDIDATE_REFERENCE,
    JSON.stringify(componentReference(binding)),
  );
  const real = await import("../../verify-release-gates.ts");
  let calls = 0;
  mock.module(new URL("../../verify-release-gates.ts", import.meta.url), {
    cache: true,
    exports: {
      ...real,
      trustedMain: async (candidate: CandidateManifest) => {
        componentRead(
          binding,
          candidate,
          real.sha256(`${real.canonicalJson(candidate)}\n`),
          componentReference(binding),
        );
        calls++;
      },
      verifyProducer: async (
        candidate: CandidateManifest,
        gate: string,
        producer: CandidateManifest["producer"],
        reference: ArtifactReference,
      ) => {
        assert.equal(gate, "candidate");
        assert.deepEqual(producer, candidate.producer);
        componentRead(
          binding,
          candidate,
          real.sha256(`${real.canonicalJson(candidate)}\n`),
          reference,
        );
        calls++;
      },
    },
  });
  return () => calls;
}

async function reload(binding: Boundary, descriptor: string) {
  await installReadSeam(binding);
  try {
    const { loadLiveDeviceInstallation } = await import("../../live-device-installation.ts");
    const result = await loadLiveDeviceInstallation(descriptor);
    await result.installed.verifyUnchanged();
    process.stdout.write(`${JSON.stringify({ accepted: true })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        accepted: false,
        assertion: condition(error) === "ERR_ASSERTION",
        importedTamper: error instanceof Error && error.message.includes("IMPORT_BEFORE_GUARD"),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

async function worker(binding: Boundary) {
  assert.equal(process.platform, "linux");
  assert.equal(process.versions.node, "26.13.1");
  assert.equal(process.getuid?.(), binding.uid);
  assert.equal(process.getgid?.(), binding.gid);
  assert.equal(process.env.HOME, undefined);
  assert.equal(process.env.USERPROFILE, undefined);
  assert.equal(homedir(), binding.userHome); // Actual passwd entry, not XDG or HOME substitution.
  assert.equal((await lstat(binding.userHome)).uid, binding.uid);
  assert.deepEqual(await readdir(binding.userHome), []);
  const mounts = (await readFile("/proc/self/mountinfo", "utf8")).split("\n");
  for (const path of ["/home", "/root", "/tmp", "/var/tmp", "/run"]) {
    assert.ok(
      mounts.some(
        (line) => line.split(" ")[4] === path && line.split(" - ")[1]?.startsWith("tmpfs "),
      ),
      "Other homes and state must be masked by actual private mounts",
    );
  }
  assert.ok(
    mounts.some(
      (line) => line.split(" ")[4] === checkout && line.split(" ")[5]?.split(",").includes("ro"),
    ),
    "Controller checkout must be read-only",
  );
  await assert.rejects(readdir("/root"), (error: unknown) =>
    ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""),
  );
  const calls = await installReadSeam(binding);
  const { installLiveDeviceCandidate, loadLiveDeviceInstallation } = await import(
    "../../live-device-installation.ts"
  );
  const { canonicalJson, saveJson, sha256 } = await import("../../verify-release-gates.ts");
  const work = await realpath(await mkdtemp(join(tmpdir(), "fortipi-device-install-case-")));
  const targetPath = join(work, "target.json"),
    descriptor = join(work, "installation.json");
  const operator = JSON.parse(
    await readFile(
      join(checkout, "packages/fortipi-cli/templates/operator-config.example.json"),
      "utf8",
    ),
  );
  await saveJson(targetPath, {
    schemaVersion: 1,
    backend: "free",
    accountBindingSha256: sha256("synthetic-unpaid-account-binding"),
    operator,
  });
  phase = "full-installed-setup";
  await installLiveDeviceCandidate({
    candidatePath: binding.candidatePath,
    targetPath,
    out: descriptor,
  });
  assert.equal((await lstat(descriptor)).mode & 0o777, 0o600);
  const originalDescriptor = await readFile(descriptor);
  const value = JSON.parse(originalDescriptor.toString());
  phase = "reload-positive";
  const loaded = await loadLiveDeviceInstallation(descriptor);
  assert.equal(loaded.installed.hash, binding.candidateSha256);
  assert.equal(loaded.target.backend, "free");
  assert.deepEqual(loaded.installed.observation, {
    independentInstalls: 5,
    combinedInstall: true,
    outsideCheckout: true,
    strictDeclarations: true,
    publicExports: 7,
    prepared: true,
    genuineDryBuild: true,
  });
  await loaded.installed.verifyUnchanged();
  async function childReload() {
    try {
      const output = await run(
        process.execPath,
        [
          "--experimental-test-module-mocks",
          script,
          "reload",
          join(binding.bridge, "frame.json"),
          descriptor,
        ],
        180000,
        process.env,
      );
      return { code: 0, result: JSON.parse(output.stdout) };
    } catch (error) {
      const e = error as { code?: unknown; stdout?: string };
      assert.equal(typeof e.code, "number");
      return { code: e.code, result: JSON.parse(e.stdout ?? "") };
    }
  }
  async function refused(name: string) {
    phase = name;
    const actual = await childReload();
    assert.equal(actual.code, 1);
    assert.deepEqual(actual.result, { accepted: false, assertion: true, importedTamper: false });
  }
  // Same original five oracles; each reload is a fresh process, not a cached import.
  await writeFile(descriptor, `${canonicalJson({ ...value, unexpected: true })}\n`);
  await refused("descriptor-extra-field");
  await writeFile(descriptor, originalDescriptor);
  const originalCandidate = await readFile(binding.candidatePath);
  const changed = JSON.parse(originalCandidate.toString());
  changed.createdAt = new Date(Date.parse(changed.createdAt) - 1).toISOString();
  await writeFile(binding.candidatePath, `${canonicalJson(changed)}\n`);
  await refused("candidate-substitution");
  await writeFile(binding.candidatePath, originalCandidate);
  const contract = loaded.installed.candidate.packages.find(
    (p) => p.sourceName === "fortipi-contract",
  );
  assert.ok(contract);
  const entry = join(loaded.installed.consumer, "node_modules", contract.name, "dist/index.js");
  const bytes = await readFile(entry),
    mode = (await lstat(entry)).mode & 0o777;
  const fault = Buffer.from('throw new Error("IMPORT_BEFORE_GUARD");\n');
  assert.ok(bytes.length >= fault.length);
  await chmod(entry, 0o600);
  await writeFile(entry, Buffer.concat([fault, Buffer.alloc(bytes.length - fault.length, 32)]));
  await chmod(entry, mode);
  await refused("changed-installed-entry");
  await chmod(entry, 0o600);
  await writeFile(entry, bytes);
  await chmod(entry, mode);
  await chmod(entry, 0o600);
  await refused("writable-installed-entry");
  await chmod(entry, mode);
  const secondLink = join(work, "hardlink-canary");
  await link(entry, secondLink);
  await refused("hardlinked-installed-entry");
  await unlink(secondLink);
  phase = "restored-reload";
  const restored = await childReload();
  assert.equal(restored.code, 0);
  assert.deepEqual(restored.result, { accepted: true });
  assert.equal(sha256(await readFile(descriptor)), sha256(originalDescriptor));
  assert.equal(sha256(await readFile(binding.candidatePath)), binding.candidateSha256);
  assert.ok(calls() >= 2);
  process.stdout.write(
    `${JSON.stringify({
      kind,
      schemaVersion: 1,
      componentOnly: true,
      publishable: false,
      scope,
      sourceCommit: binding.sourceCommit,
      candidateSha256: binding.candidateSha256,
      assetManifestSha256: binding.assetManifestSha256,
      passed: true,
      sourceReadProvenanceSeam: true,
      genuineGitHubCandidate: false,
      emptyOsHomeInitially: true,
      dedicatedIdentity: true,
      otherHomesMasked: true,
      controllerCheckoutReadOnly: true,
      network: "hosted-hardener-public-registry",
      actualInstalledImports: true,
      strictDeclarations: true,
      actualPinnedWranglerDryBuild: true,
      targetPrepare: true,
      privateDescriptor: true,
      freshProcessReload: true,
      tamperCanaries: 5,
      restored: true,
    })}\n`,
  );
}

async function namespace(binding: Boundary, framePath: string) {
  phase = "namespace";
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid?.(), 0);
  const mount = await host("/usr/bin/mount");
  const bind = async (source: string, target: string) => {
    await mkdir(target, { recursive: true });
    await run(mount, ["--bind", source, target]);
    await run(mount, ["-o", "remount,bind,ro,nosuid,nodev", target]);
  };
  process.chdir("/");
  await run(mount, ["--make-rprivate", "/"]);
  // Preserve ONLY the test/controller source tree. Product packages are freshly installed elsewhere.
  const preserved = join(binding.bridge, "checkout");
  await bind(checkout, preserved);
  for (const [path, mode] of [
    ["/home", "0755"],
    ["/root", "0000"],
    ["/tmp", "1777"],
    ["/var/tmp", "1777"],
    ["/run", "0755"],
  ]) {
    assert.ok(path && mode);
    await mkdir(path, { recursive: true });
    await run(mount, ["-t", "tmpfs", "-o", `mode=${mode},nosuid,nodev`, "tmpfs", path]);
  }
  await bind(preserved, checkout);
  await mkdir(binding.userHome, { mode: 0o700 });
  await run(await host("/usr/bin/chown"), [`${binding.uid}:${binding.gid}`, binding.userHome]);
  const env: NodeJS.ProcessEnv = {
    PATH: `${binding.bridge}/bin:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    GITHUB_ACTIONS: binding.githubActions,
    FORTIPI_CANDIDATE_REFERENCE: JSON.stringify(componentReference(binding)),
  };
  const result = await run(
    await host("/usr/bin/setpriv"),
    [
      `--reuid=${binding.uid}`,
      `--regid=${binding.gid}`,
      "--clear-groups",
      "--no-new-privs",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      join(binding.bridge, "bin/node"),
      "--experimental-test-module-mocks",
      script,
      "worker",
      framePath,
    ],
    900000,
    env,
  );
  process.stdout.write(result.stdout);
}

async function controller(directory: string) {
  assert.equal(process.platform, "linux", "Actual hosted Linux required before any home lookup");
  assert.equal(process.versions.node, "26.13.1");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_JOB, "installed-offline");
  assert.match(process.env.GITHUB_REF ?? "", /^refs\/heads\/ci\/fortipi-cli-proof-[\w.-]+$/);
  assert.equal(process.env.GITHUB_REPOSITORY, "scottdraper8/fortipi");
  assert.ok(checkout.startsWith("/home/runner/work/"), "Expected actual hosted checkout layout");
  assert.ok(isAbsolute(directory));
  assert.equal(directory, join(process.env.RUNNER_TEMP ?? "", "fortipi-cli-distribution"));
  const git = async (...args: string[]) =>
    (await run("/usr/bin/git", ["-C", checkout, ...args])).stdout.trim();
  assert.equal(await git("status", "--porcelain"), "");
  const sourceCommit = await git("rev-parse", "HEAD");
  assert.equal(sourceCommit, process.env.SOURCE_SHA);
  await run("/usr/bin/systemctl", ["is-active", "--quiet", "agent.service"]);
  const { readDistributionReceipt } = await import(
    "../../../packages/fortipi-cli/test/offline-consumer.ts"
  );
  const receipt = await readDistributionReceipt(join(directory, "distribution.json"));
  assert.equal(receipt.sourceCommit, sourceCommit);
  assert.equal(receipt.checkout, checkout);
  const component = join(dirname(directory), `${basename(directory)}-source-component`);
  const candidatePath = join(component, "candidate.json");
  phase = "authenticate-existing-source-component";
  // No fabricated GitHub producer. Actual clean-source reproduction authenticates this reserved component.
  const { loadCandidate } = await import("../../prepare-release.ts");
  const loaded = await loadCandidate(candidatePath);
  assert.equal(loaded.candidate.publishable, false);
  assert.equal(loaded.candidate.scope, scope);
  assert.equal(loaded.candidate.sourceCommit, sourceCommit);
  assert.equal(loaded.candidate.assetManifestSha256, receipt.assetManifestSha256);
  assert.deepEqual(
    [
      loaded.candidate.producer.workflowId,
      loaded.candidate.producer.runId,
      loaded.candidate.producer.runAttempt,
    ],
    [0, 0, 0],
  );
  const id = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  assert.match(id, /^[0-9]+-[0-9]+$/);
  const user = `fortipi-device-${id}`;
  assert.ok(user.length <= 32);
  const bridge = `/opt/fortipi-device-proof-${id}`,
    userHome = `/home/${user}`;
  const sudo = async (file: string, args: string[]) => run("/usr/bin/sudo", ["-n", file, ...args]);
  phase = "dedicated-identity";
  await sudo(await host("/usr/sbin/useradd"), [
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
    const boundary: Boundary = {
      bridge,
      userHome,
      uid,
      gid,
      checkoutUid: (await lstat(checkout)).uid,
      githubActions: process.env.GITHUB_ACTIONS,
      sourceCommit,
      candidateSha256: loaded.hash,
      assetManifestSha256: receipt.assetManifestSha256,
      candidatePath: join(bridge, "component/candidate.json"),
    };
    assert.ok(uid > 0 && uid !== boundary.checkoutUid && Number.isSafeInteger(gid));
    await sudo(await host("/usr/bin/install"), [
      "-d",
      "-m",
      "0755",
      join(bridge, "bin"),
      join(bridge, "pnpm"),
    ]);
    await sudo(await host("/usr/bin/install"), [
      "-m",
      "0555",
      process.execPath,
      join(bridge, "bin/node"),
    ]);
    const pnpmRoot = process.env.FORTIPI_CLI_PROOF_PNPM,
      pnpmBin = process.env.FORTIPI_CLI_PROOF_PNPM_BIN;
    assert.ok(pnpmRoot && pnpmBin && isAbsolute(pnpmRoot) && pnpmBin.startsWith(`${pnpmRoot}/`));
    assert.equal((await run(join(pnpmBin, "pnpm"), ["--version"])).stdout.trim(), "12.18.0");
    await sudo(await host("/usr/bin/cp"), [
      "-a",
      join(pnpmRoot, "node_modules"),
      join(bridge, "pnpm/node_modules"),
    ]);
    await sudo(await host("/usr/bin/ln"), [
      "-s",
      `../pnpm/${relative(pnpmRoot, join(pnpmBin, "pnpm"))}`,
      join(bridge, "bin/pnpm"),
    ]);
    await sudo(await host("/usr/bin/cp"), ["-a", component, join(bridge, "component")]);
    await sudo(await host("/usr/bin/chown"), ["-R", `${uid}:${gid}`, join(bridge, "component")]);
    const temporary = await mkdtemp(join(await realpath(tmpdir()), "fortipi-device-frame-"));
    const frameSource = join(temporary, "frame.json");
    await writeFile(frameSource, `${JSON.stringify(boundary)}\n`, { mode: 0o600 });
    await sudo(await host("/usr/bin/install"), [
      "-m",
      "0444",
      frameSource,
      join(bridge, "frame.json"),
    ]);
    await rm(temporary, { recursive: true });
    phase = "isolated-full-helper";
    const result = await run(
      "/usr/bin/sudo",
      [
        "-n",
        await host("/usr/bin/unshare"),
        "--mount",
        "--pid",
        "--fork",
        "--mount-proc",
        "--kill-child",
        join(bridge, "bin/node"),
        script,
        "namespace",
        join(bridge, "frame.json"),
      ],
      960000,
    );
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.kind, kind);
    assert.equal(proof.componentOnly, true);
    assert.equal(proof.publishable, false);
    assert.equal(proof.sourceReadProvenanceSeam, true);
    assert.equal(proof.genuineGitHubCandidate, false);
    assert.equal(proof.sourceCommit, sourceCommit);
    assert.equal(proof.candidateSha256, loaded.hash);
    for (const key of [
      "passed",
      "emptyOsHomeInitially",
      "dedicatedIdentity",
      "otherHomesMasked",
      "controllerCheckoutReadOnly",
      "actualInstalledImports",
      "strictDeclarations",
      "actualPinnedWranglerDryBuild",
      "targetPrepare",
      "privateDescriptor",
      "freshProcessReload",
      "restored",
    ])
      assert.equal(proof[key], true);
    assert.equal(proof.tamperCanaries, 5);
    await writeFile(
      join(checkout, "dist/cli-proof/device-installation.json"),
      `${JSON.stringify(proof, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(
      `${JSON.stringify({ kind, componentOnly: true, passed: true, sourceCommit })}\n`,
    );
  } finally {
    const previous = phase;
    phase = "cleanup";
    await sudo(await host("/usr/sbin/userdel"), [user]);
    await sudo(await host("/usr/bin/rm"), ["-rf", "--", bridge]);
    phase = previous;
  }
}

if (import.meta.main) {
  try {
    const [mode, path, descriptor] = process.argv.slice(2);
    if (mode === "--distribution") {
      assert.ok(path && !descriptor);
      await controller(path);
    } else if (mode === "namespace" || mode === "worker" || mode === "reload") {
      assert.ok(path);
      const binding = await frame(path);
      if (mode === "namespace") await namespace(binding, path);
      else if (mode === "worker") await worker(binding);
      else {
        assert.ok(descriptor);
        await reload(binding, descriptor);
      }
    } else throw new Error("Explicit component proof phase required");
  } catch (error) {
    const { installedFailureLocation } = await import("../../cli-proof.ts");
    process.stderr.write(
      `${JSON.stringify({
        kind,
        componentOnly: true,
        passed: false,
        phase,
        condition: condition(error),
        location: installedFailureLocation(
          error instanceof Error ? error.stack : undefined,
          diagnosticSources,
        ),
      })}\n`,
    );
    process.exitCode = 1;
  }
}
