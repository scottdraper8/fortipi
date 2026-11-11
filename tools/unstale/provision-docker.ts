// CI-only Linux image tooling. No product bytes or credentials enter this directory.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { release, tmpdir, userInfo } from "node:os";
import { basename, delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import { repository } from "../../scripts/build-workspaces.ts";
import { json } from "../../scripts/check-pins.ts";
import { archiveEntries, hash } from "./review-supply-chain.ts";

assert.equal(process.platform, "linux", "Docker CI provisioning requires an actual Linux job");
assert.equal(process.arch, "x64", "Docker CI provisioning requires an actual x64 job");
assert.ok(
  process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_JOB &&
    process.env.GITHUB_PATH &&
    process.env.GITHUB_ENV,
  "This provisioner is only for isolated GitHub Linux runners",
);
assert.ok(
  process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--rootless"),
  "Usage: node tools/unstale/provision-docker.ts [--rootless]",
);
const rootless = process.argv[2] === "--rootless";
const policy = await json<{
  docker: { url: string; sha256: string; version: string; buildkit: string };
  buildx: {
    url: string;
    sha256: string;
    version: string;
    source: string;
    licensePath: string;
    licenseSha256: string;
  };
  rootless: {
    url: string;
    sha256: string;
    files: Record<string, string>;
    rootlesskit: { version: string; source: string; go: string };
    licenses: { path: string; sha256: string }[];
    uidmap: { version: string; binaries: Record<string, string> };
  };
}>(repository, "tools/unstale/platform-tools.json");
const exec = promisify(execFile);
// Do not expose child stdout/stderr through an uncaught execFile error.
async function command(file: string, args: string[], env: NodeJS.ProcessEnv, timeout = 30_000) {
  try {
    return (await exec(file, args, { env, timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }))
      .stdout;
  } catch {
    throw new Error(`${basename(file)} ${args[0] ?? ""} failed or timed out`);
  }
}

async function download(url: string, sha256: string, cacheName: string): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(resolve(repository, "dist/toolchain", cacheName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    assert.ok(response.ok, `Public tooling download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  assert.equal(hash(bytes), sha256, `${cacheName}: reviewed identity changed`);
  return bytes;
}

async function optionalSetting(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

async function rootlessPrerequisites(directory: string, env: NodeJS.ProcessEnv): Promise<void> {
  const user = userInfo();
  assert.ok(
    user.uid > 0 && process.geteuid?.() === user.uid,
    "rootless prerequisite: nonroot job user",
  );
  const kernel = /^(\d+)\.(\d+)/.exec(release());
  assert.ok(
    kernel && (Number(kernel[1]) > 5 || (Number(kernel[1]) === 5 && Number(kernel[2]) >= 11)),
    "rootless prerequisite: existing Linux >=5.11 for overlay2; no kernel changes performed",
  );
  assert.notEqual(
    await optionalSetting("/proc/sys/kernel/unprivileged_userns_clone"),
    "0",
    "rootless prerequisite: host permits unprivileged user namespaces",
  );
  assert.ok(
    Number(await optionalSetting("/proc/sys/user/max_user_namespaces")) > 0,
    "rootless prerequisite: host has available user namespaces",
  );
  for (const [path, id] of [
    ["/etc/subuid", user.uid],
    ["/etc/subgid", user.gid],
  ] as const) {
    const ranges = (await readFile(path, "utf8")).trim().split("\n");
    assert.ok(
      ranges.some((line) => {
        const [name, first, count] = line.split(":");
        const start = Number(first);
        const size = Number(count);
        return (
          (name === user.username || name === String(user.uid)) &&
          Number.isSafeInteger(start) &&
          Number.isSafeInteger(size) &&
          start > 0 &&
          size >= 65_536 &&
          start + size <= 2 ** 32 &&
          (id < start || id >= start + size)
        );
      }),
      `rootless prerequisite: ${path} needs >=65,536 subordinate IDs for this user`,
    );
  }
  assert.equal(
    (
      await command(
        "/usr/bin/dpkg-query",
        [
          "--show",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal dpkg-query syntax, passed without a shell.
          "--showformat=${Status}\t${Version}\t${Architecture}",
          "uidmap",
        ],
        env,
      )
    ).trim(),
    `install ok installed\t${policy.rootless.uidmap.version}\tamd64`,
    "rootless prerequisite: installed uidmap must match the exact reviewed Ubuntu amd64 fixture; no packages installed",
  );
  assert.deepEqual(Object.keys(policy.rootless.uidmap.binaries).sort(), ["newgidmap", "newuidmap"]);
  for (const [name, expected] of Object.entries(policy.rootless.uidmap.binaries)) {
    const path = `/usr/bin/${name}`;
    const stat = await lstat(path);
    assert.ok(
      stat.isFile() &&
        stat.uid === 0 &&
        (stat.mode & 0o4111) === 0o4111 &&
        (stat.mode & 0o022) === 0,
      `rootless prerequisite: ${name} must be a root-owned setuid file, without group/other write`,
    );
    assert.equal(
      hash(await readFile(path)),
      expected,
      `rootless prerequisite: ${name} binary changed`,
    );
  }
  for (const [path, minor] of [
    ["/dev/fuse", 229],
    ["/dev/net/tun", 200],
  ] as const) {
    const device = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = await device.stat();
      assert.ok(
        stat.isCharacterDevice() && stat.rdev === 10 * 256 + minor,
        `rootless prerequisite: accessible actual ${path} character device (10:${minor})`,
      );
    } finally {
      await device.close();
    }
  }
  if ((await optionalSetting("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")) === "1") {
    assert.equal(
      await optionalSetting("/sys/module/apparmor/parameters/enabled"),
      "Y",
      "rootless prerequisite: AppArmor restriction requires the active exact-path profile",
    );
    const executable = await realpath(resolve(directory, "rootlesskit"));
    assert.match(
      executable,
      /^\/[A-Za-z0-9_./-]+$/,
      "rootless prerequisite: simple absolute checkout path",
    );
    const profileName = `fortipi-rootlesskit-${hash(Buffer.from(executable)).slice(0, 16)}`;
    const local = resolve(env.XDG_RUNTIME_DIR ?? "", "rootlesskit.apparmor");
    // Docker's documented path attachment, loaded alone. No sysctl/global policy changes.
    await writeFile(
      local,
      `abi <abi/4.0>,\ninclude <tunables/global>\n"${executable}" flags=(unconfined) {\n  userns,\n}\n`,
      { mode: 0o600 },
    );
    const target = `/etc/apparmor.d/${profileName}`;
    await command(
      "/usr/bin/sudo",
      ["-n", "install", "-o", "root", "-g", "root", "-m", "0644", "--", local, target],
      env,
    );
    await command("/usr/bin/sudo", ["-n", "apparmor_parser", "-r", target], env);
  }
  console.log(
    `Rootless host prerequisites verified: Linux ${release()}, uidmap ${policy.rootless.uidmap.version}, actual FUSE/TUN devices; mount proof pending`,
  );
}
assert.equal(policy.docker.version, "29.9.3");
assert.equal(policy.docker.buildkit, "0.34.2");
assert.equal(
  policy.docker.url,
  "https://download.docker.com/linux/static/stable/x86_64/docker-29.9.3.tgz",
);
await mkdir(resolve(repository, "dist/toolchain"), { recursive: true });
const directory = rootless
  ? await mkdtemp(resolve(repository, "dist/toolchain/docker-rootless-"))
  : resolve(repository, "dist/toolchain/docker");
await mkdir(directory, { recursive: true });
if (rootless)
  assert.match(
    directory,
    /^\/[A-Za-z0-9_./-]+$/,
    "rootless prerequisite: simple absolute checkout path",
  );
const raw = await download(policy.docker.url, policy.docker.sha256, "docker-29.9.3.tgz");
for (const [path, bytes] of archiveEntries(raw)) {
  assert.match(path, /^docker\/[a-z0-9-]+$/);
  const target = resolve(directory, basename(path));
  await writeFile(target, bytes);
  await chmod(target, 0o755);
}
if (rootless) {
  assert.equal(
    policy.rootless.url,
    "https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-29.9.3.tgz",
  );
  assert.equal(policy.rootless.rootlesskit.version, "3.3.0");
  for (const license of policy.rootless.licenses)
    assert.equal(
      hash(await readFile(resolve(repository, license.path))),
      license.sha256,
      "Rootless tooling license changed",
    );
  const entries = archiveEntries(
    await download(
      policy.rootless.url,
      policy.rootless.sha256,
      "docker-rootless-extras-29.9.3.tgz",
    ),
  );
  assert.deepEqual(
    [...entries.keys()].sort(),
    ["dockerd-rootless-setuptool.sh", "dockerd-rootless.sh", "rootlesskit"].map(
      (name) => `docker-rootless-extras/${name}`,
    ),
  );
  assert.deepEqual(Object.keys(policy.rootless.files).sort(), [
    "dockerd-rootless-setuptool.sh",
    "dockerd-rootless.sh",
    "rootlesskit",
  ]);
  for (const [name, expected] of Object.entries(policy.rootless.files)) {
    const bytes = entries.get(`docker-rootless-extras/${name}`);
    assert.ok(bytes);
    assert.equal(hash(bytes), expected, `${name}: reviewed identity changed`);
    if (name === "rootlesskit") {
      for (const identity of [
        `mod\tgithub.com/rootless-containers/rootlesskit/v3\tv${policy.rootless.rootlesskit.version}\t`,
        `build\tvcs.revision=${policy.rootless.rootlesskit.source}\n`,
        "build\tvcs.modified=false\n",
        policy.rootless.rootlesskit.go,
      ])
        assert.ok(bytes.includes(identity), "RootlessKit embedded source/build identity changed");
    }
    if (name === "dockerd-rootless-setuptool.sh") continue; // No home/context/systemd installer.
    await writeFile(resolve(directory, name), bytes, { mode: 0o755 });
  }
}
assert.equal(policy.buildx.version, "0.38.2");
assert.equal(
  policy.buildx.url,
  "https://github.com/docker/buildx/releases/download/v0.38.2/buildx-v0.38.2.linux-amd64",
);
assert.equal(
  hash(await readFile(resolve(repository, policy.buildx.licensePath))),
  policy.buildx.licenseSha256,
  "Buildx license identity changed",
);
const plugins = resolve(directory, "cli-plugins");
// Rootless job state must not collide with a previous daemon or inherit Docker credentials.
const session = rootless ? await mkdtemp(resolve(tmpdir(), "fortipi-docker-")) : directory;
if (rootless)
  assert.match(
    session,
    /^\/[A-Za-z0-9_./-]+$/,
    "rootless prerequisite: simple absolute temporary path",
  );
const config = resolve(session, "config");
await mkdir(plugins, { recursive: true });
await mkdir(config, { recursive: true });
const buildx = await download(
  policy.buildx.url,
  policy.buildx.sha256,
  "buildx-v0.38.2.linux-amd64",
);
await writeFile(resolve(plugins, "docker-buildx"), buildx);
await chmod(resolve(plugins, "docker-buildx"), 0o755);
await writeFile(resolve(config, "config.json"), JSON.stringify({ cliPluginsExtraDirs: [plugins] }));
const env: NodeJS.ProcessEnv = {
  ...(rootless
    ? Object.fromEntries(
        Object.entries(process.env).filter(([key]) => ["HOME", "CODEX_HOME", "LANG"].includes(key)),
      )
    : process.env),
  PATH: `${directory}${delimiter}${rootless ? "/usr/bin:/bin:/usr/sbin:/sbin" : (process.env.PATH ?? "")}`,
  DOCKER_HOST: `unix://${session}/docker.sock`,
  DOCKER_CONFIG: config,
  BUILDX_CONFIG: resolve(config, "buildx"),
  BUILDX_BUILDER: "default",
};
for (const name of [
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "BUILDKIT_HOST",
])
  delete env[name];
if (rootless) {
  assert.ok(
    env.HOME?.startsWith("/"),
    "rootless prerequisite: retain the job user's original HOME",
  );
  Object.assign(env, {
    XDG_RUNTIME_DIR: resolve(session, "runtime"),
    XDG_CONFIG_HOME: resolve(session, "xdg-config"),
    DOCKERD: resolve(directory, "dockerd"),
    DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR: resolve(session, "state"),
    DOCKERD_ROOTLESS_ROOTLESSKIT_NET: "gvisor-tap-vsock",
    DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER: "builtin",
    DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK: "true",
    DOCKERD_ROOTLESS_ROOTLESSKIT_FLAGS: "--subid-source=static",
  });
  await mkdir(env.XDG_RUNTIME_DIR ?? "", { mode: 0o700 });
  await mkdir(env.XDG_CONFIG_HOME ?? "", { mode: 0o700 });
  try {
    await rootlessPrerequisites(directory, env);
  } catch (error) {
    throw new Error(
      `rootless prerequisite failed: ${error instanceof Error ? error.message : "unavailable host baseline"}`,
    );
  }
  assert.match(
    (await command(resolve(directory, "rootlesskit"), ["--version"], env)).trim(),
    /^rootlesskit version 3\.3\.0(?:\s|$)/,
  );
  assert.match(
    await command(resolve(directory, "rootlesskit"), ["--help"], env),
    /gvisor-tap-vsock/,
  );
}
for (const name of ["docker", "dockerd"])
  assert.match(await command(resolve(directory, name), ["--version"], env), /\b29\.9\.3(?:,|\s|$)/);
await command("sudo", ["-n", "systemctl", "stop", "docker.service", "docker.socket"], env);
const log = rootless ? undefined : await open(resolve(directory, "daemon.log"), "w");
const daemonConfig = resolve(config, "daemon.json");
if (rootless) await writeFile(daemonConfig, "{}\n", { mode: 0o600 });
const daemon = spawn(
  rootless ? resolve(directory, "dockerd-rootless.sh") : "sudo",
  [
    ...(rootless
      ? [
          "--rootless",
          "--config-file",
          daemonConfig,
          "--storage-driver",
          "overlay2",
          "--log-level",
          "error",
        ]
      : ["-n", resolve(directory, "dockerd")]),
    "--host",
    `unix://${session}/docker.sock`,
    "--data-root",
    `${session}/data`,
    "--exec-root",
    `${session}/exec`,
    "--pidfile",
    `${session}/daemon.pid`,
  ],
  // Rootless output goes to /dev/null: bounded at zero, no logger keeping Node alive.
  { env, detached: true, stdio: ["ignore", log?.fd ?? "ignore", log?.fd ?? "ignore"] },
);
let stopped: string | undefined;
daemon.once("error", () => {
  stopped = "spawn error";
});
daemon.once("exit", (code, signal) => {
  stopped = `exit ${signal ?? code}`;
});
daemon.unref();
await log?.close();
try {
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (!stopped && Date.now() < deadline) {
    try {
      assert.equal(
        (
          await command(
            resolve(directory, "docker"),
            ["version", "--format", "{{.Server.Version}}"],
            env,
            3_000,
          )
        ).trim(),
        "29.9.3",
      );
      ready = true;
      break;
    } catch {
      await new Promise((accept) => setTimeout(accept, 500));
    }
  }
  assert.ok(
    ready,
    rootless
      ? `rootless prerequisite: pinned nonroot daemon unavailable (${stopped ?? "60s deadline"}); check host namespace/AppArmor/iptables/storage support; daemon output discarded`
      : "Pinned Docker daemon failed; inspect ignored daemon.log",
  );
  if (rootless) {
    const options = JSON.parse(
      await command(
        resolve(directory, "docker"),
        ["info", "--format", "{{json .SecurityOptions}}"],
        env,
      ),
    ) as string[];
    assert.ok(options.includes("name=rootless"), "Daemon is not actually rootless");
    const pid = (await readFile(resolve(session, "daemon.pid"), "utf8")).trim();
    assert.match(pid, /^[1-9]\d*$/);
    for (const processId of [String(daemon.pid), pid]) {
      const status = await readFile(`/proc/${processId}/status`, "utf8");
      const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
      assert.ok(
        uids?.slice(1).every((uid) => Number(uid) === process.getuid?.()),
        "RootlessKit and dockerd must run as the nonroot job user on the host",
      );
    }
  }
  const activeBuildx = (
    await command(resolve(directory, "docker"), ["buildx", "version"], env)
  ).trim();
  const identity = /^github\.com\/docker\/buildx v(\d+\.\d+\.\d+) ([a-f0-9]{7,40})$/.exec(
    activeBuildx,
  );
  const builder = await command(
    resolve(directory, "docker"),
    ["buildx", "inspect", "default", "--timeout", "15s"],
    env,
  );
  assert.match(builder, /^Driver:\s+docker\s*$/m, "Must use the default embedded Docker driver");
  assert.match(builder, /^Status:\s+running\s*$/m);
  assert.equal(
    /^BuildKit(?: version)?:\s+v?(\d+\.\d+\.\d+)/m.exec(builder)?.[1],
    policy.docker.buildkit,
    "Embedded BuildKit identity changed",
  );
  assert.equal(
    identity?.[1],
    policy.buildx.version,
    "The active plugin must be the reviewed version",
  );
  assert.ok(
    identity?.[2] && policy.buildx.source.startsWith(identity[2]),
    "Buildx source identity changed",
  );
  await writeFile(process.env.GITHUB_PATH, `${directory}\n`, { flag: "a" });
  await writeFile(
    process.env.GITHUB_ENV,
    `DOCKER_HOST=${env.DOCKER_HOST}\nDOCKER_CONFIG=${config}\nBUILDX_CONFIG=${env.BUILDX_CONFIG}\nBUILDX_BUILDER=default\nDOCKER_CONTEXT=\nDOCKER_TLS=\nDOCKER_TLS_VERIFY=\nDOCKER_CERT_PATH=\nBUILDKIT_HOST=\n`,
    { flag: "a" },
  );
  console.log(
    `Docker CLI/Engine 29.9.3 (${rootless ? "rootless" : "rootful"}), Buildx 0.38.2/default embedded BuildKit ${policy.docker.buildkit} verified; actual image/FUSE evidence is still required`,
  );
} catch (error) {
  if (rootless && daemon.pid && !stopped) {
    try {
      process.kill(-daemon.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + 5_000;
    while (!stopped && Date.now() < deadline)
      await new Promise((accept) => setTimeout(accept, 100));
    if (!stopped) {
      try {
        process.kill(-daemon.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  throw error;
}
