// CI-only Linux image tooling. No product bytes or credentials enter this directory.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isIPv4 } from "node:net";
import { release, tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { repository } from "../../scripts/build-workspaces.ts";
import { json } from "../../scripts/check-pins.ts";
import { archiveEntries, hash } from "./review-supply-chain.ts";

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
    rootlesskit: {
      version: string;
      source: string;
      go: string;
      sourceArchiveSha256: string;
      goModSha256: string;
      goSumSha256: string;
      moduleGraphSha256: string;
      packageGraphSha256: string;
      binarySha256: string;
    };
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
  let downloaded = false;
  try {
    bytes = await readFile(resolve(repository, "dist/toolchain", cacheName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    assert.ok(response.ok, `Public tooling download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    downloaded = true;
  }
  assert.equal(hash(bytes), sha256, `${cacheName}: reviewed identity changed`);
  // The namespace verifier independently binds its daemon to this publisher archive.
  if (downloaded && cacheName === "docker-29.9.3.tgz")
    await writeFile(resolve(repository, "dist/toolchain", cacheName), bytes, {
      flag: "wx",
      mode: 0o600,
    });
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

// Same supported upstream target on CI and in independent cross-build verification.
export async function prepareRootlesskit(directory: string, compiler = "go"): Promise<void> {
  const pin = policy.rootless.rootlesskit;
  assert.equal(pin.go, "go1.27.4");
  const source = resolve(directory, "rootlesskit-source");
  await mkdir(source, { mode: 0o700 });
  const raw = await download(
    `https://codeload.github.com/rootless-containers/rootlesskit/tar.gz/${pin.source}`,
    pin.sourceArchiveSha256,
    "rootlesskit-source.tgz",
  );
  const prefix = `rootlesskit-${pin.source}/`;
  for (const [name, bytes] of archiveEntries(raw)) {
    assert.ok(name.startsWith(prefix), "Unexpected RootlessKit source root");
    const target = resolve(source, name.slice(prefix.length));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const env = {
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    LANG: "C",
    PATH: process.env.PATH,
    GOENV: "off",
    GOTOOLCHAIN: "local",
    GOAUTH: "off",
    GOVCS: "*:off",
    GOPATH: resolve(directory, "go"),
    GOMODCACHE: resolve(directory, "go/pkg/mod"),
    GOCACHE: resolve(directory, "go/cache"),
    GOPROXY: "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
    CGO_ENABLED: "0",
    GOOS: "linux",
    GOARCH: "amd64",
    GOAMD64: "v1",
  };
  const go = async (args: string[]) => {
    try {
      return (
        await exec(compiler, args, {
          cwd: source,
          env,
          timeout: 300_000,
          killSignal: "SIGKILL",
          maxBuffer: 256 * 1024,
        })
      ).stdout;
    } catch {
      throw new Error(
        `RootlessKit source build: go ${args[0]} failed; no credentials or VCS fallback enabled`,
      );
    }
  };
  assert.match(await go(["version"]), /^go version go1\.27\.4 /);
  const checkInputs = async () => {
    assert.equal(hash(await readFile(resolve(source, "go.mod"))), pin.goModSha256);
    assert.equal(hash(await readFile(resolve(source, "go.sum"))), pin.goSumSha256);
  };
  await checkInputs();
  await go(["mod", "download"]); // Public proxy plus Go's authenticated checksum database.
  assert.match(await go(["mod", "verify"]), /all modules verified/);
  await checkInputs();
  const normalize = (text: string) =>
    `${text
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .sort()
      .join("\n")}\n`;
  const modules = normalize(
    await go([
      "list",
      "-mod=readonly",
      "-m",
      "-f",
      "{{.Path}} {{.Version}} {{.Sum}} {{.GoModSum}}",
      "all",
    ]),
  );
  const packages = normalize(
    await go(["list", "-mod=readonly", "-deps", "-f", "{{.ImportPath}}", "./cmd/rootlesskit"]),
  );
  assert.equal(hash(Buffer.from(modules)), pin.moduleGraphSha256, "Frozen Go module graph changed");
  assert.equal(
    hash(Buffer.from(packages)),
    pin.packageGraphSha256,
    "Selected Linux Go package graph changed",
  );
  assert.ok(
    !packages
      .split("\n")
      .some(
        (path) =>
          path === "golang.org/x/net/html" || path.startsWith("golang.org/x/crypto/openpgp"),
      ),
    "Affected HTML/OpenPGP packages entered the build",
  );
  const binary = resolve(directory, "rootlesskit");
  await go([
    "build",
    "-mod=readonly",
    "-trimpath",
    "-buildvcs=false",
    "-ldflags=-s -w",
    "-o",
    binary,
    "./cmd/rootlesskit",
  ]);
  await checkInputs();
  assert.equal(
    hash(await readFile(binary)),
    pin.binarySha256,
    "Reviewed RootlessKit source-build output changed",
  );
  const build = await go(["version", "-m", binary]);
  assert.ok(
    build.includes(": go1.27.4\n") &&
      build.includes("GOOS=linux") &&
      build.includes("CGO_ENABLED=0"),
  );
  await writeFile(
    resolve(directory, "rootlesskit-build.json"),
    `${JSON.stringify({ source: pin.source, sourceArchiveSha256: pin.sourceArchiveSha256, compiler: pin.go, binarySha256: pin.binarySha256, modules, packages, build }, null, 2)}\n`,
  );
}

type IdRange = { first: number; count: number };
export function verifyIdMap(text: string, host: number, ranges: IdRange[]): void {
  assert.ok(Number.isSafeInteger(host) && host > 0, "Host identity must be nonroot");
  const rows = text
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  assert.deepEqual(
    rows[0],
    [0, host, 1],
    "Namespace root must map only to the nonroot job identity",
  );
  let next = 1;
  for (const [inside, outside, count] of rows.slice(1)) {
    assert.ok(
      inside === next &&
        outside !== undefined &&
        count !== undefined &&
        Number.isSafeInteger(count) &&
        count > 0 &&
        ranges.some((r) => outside >= r.first && outside + count <= r.first + r.count),
      "Unexpected subordinate namespace mapping",
    );
    next += count;
  }
  assert.ok(next >= 65_537, "Actual namespace requires at least 65,536 subordinate IDs");
}

async function rootlessPrerequisites(
  directory: string,
  env: NodeJS.ProcessEnv,
): Promise<IdRange[][]> {
  const user = userInfo();
  assert.ok(
    user.uid > 0 &&
      user.gid > 0 &&
      process.geteuid?.() === user.uid &&
      process.getegid?.() === user.gid,
    "rootless prerequisite: nonroot job user",
  );
  // The private XDG runtime has no user bus. Bind runc to this UID's real user manager,
  // rather than falling back to the privileged system bus for cgroup scopes.
  await command("sudo", ["-n", "systemctl", "start", `user@${user.uid}.service`], env);
  const userRuntime = `/run/user/${user.uid}`;
  const runtime = await lstat(userRuntime);
  assert.ok(
    runtime.isDirectory() && runtime.uid === user.uid && (runtime.mode & 0o777) === 0o700,
    "rootless prerequisite: actual UID's private systemd runtime directory",
  );
  const bus = await lstat(`${userRuntime}/bus`);
  assert.ok(bus.isSocket() && bus.uid === user.uid, "rootless prerequisite: actual UID's user bus");
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${userRuntime}/bus`;
  assert.equal(
    (await command("systemctl", ["--user", "is-active", "dbus.socket"], env)).trim(),
    "active",
    "rootless prerequisite: existing user D-Bus session must be active",
  );
  const controllers = (
    await readFile(
      `/sys/fs/cgroup/user.slice/user-${user.uid}.slice/user@${user.uid}.service/cgroup.controllers`,
      "utf8",
    )
  )
    .trim()
    .split(/\s+/);
  assert.ok(
    ["cpu", "memory", "pids"].every((controller) => controllers.includes(controller)),
    "rootless prerequisite: cgroup v2 CPU/memory/PID delegation required; no limits disabled",
  );
  console.log(
    "Rootless actual-UID private user bus and cgroup v2 CPU/memory/PID delegation verified",
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
  const allocated: IdRange[][] = [];
  // CVE-2024-56433: an NSS namespace with remote identities cannot be validated here.
  const nss = await readFile("/etc/nsswitch.conf", "utf8");
  const localFilesystems = new Set(
    "ext4 xfs btrfs overlay squashfs vfat ramfs tmpfs devtmpfs devpts proc sysfs cgroup cgroup2 pstore securityfs debugfs tracefs bpf configfs fusectl mqueue hugetlbfs efivarfs binfmt_misc nsfs".split(
      " ",
    ),
  );
  assert.ok(
    (await readFile("/proc/self/mountinfo", "utf8"))
      .trim()
      .split("\n")
      .every((line) => {
        const [mount, properties] = line.split(" - ");
        const type = properties?.split(" ")[0];
        return (
          type !== undefined &&
          (localFilesystems.has(type) ||
            (type === "autofs" && mount?.split(" ")[4] === "/proc/sys/fs/binfmt_misc"))
        );
      }),
    "rootless prerequisite: local host filesystems required; remote numeric ownership cannot be checked for CVE-2024-56433",
  );
  for (const database of ["passwd", "group"]) {
    const sources = new RegExp(`^${database}:\\s*(.+)$`, "m")
      .exec(nss)?.[1]
      ?.split("#")[0]
      ?.trim()
      .split(/\s+/);
    assert.ok(
      sources?.length && sources.every((source) => ["files", "systemd"].includes(source)),
      "rootless prerequisite: local-only host account sources required to exclude subordinate-ID collisions",
    );
  }
  for (const [path, id, database] of [
    ["/etc/subuid", user.uid, "passwd"],
    ["/etc/subgid", user.gid, "group"],
  ] as const) {
    const ranges = (await readFile(path, "utf8")).trim().split("\n");
    const selected: IdRange[] = [];
    for (const line of ranges) {
      const [name, first, count] = line.split(":");
      if (name !== user.username && name !== String(user.uid)) continue;
      const start = Number(first);
      const size = Number(count);
      assert.ok(
        Number.isSafeInteger(start) &&
          Number.isSafeInteger(size) &&
          start > 0 &&
          size >= 65_536 &&
          start + size <= 2 ** 32 &&
          (id < start || id >= start + size),
        `rootless prerequisite: invalid subordinate range in ${path}`,
      );
      selected.push({ first: start, count: size });
    }
    assert.ok(selected.length, `rootless prerequisite: ${path} needs >=65,536 subordinate IDs`);
    const identities = (await command("/usr/bin/getent", [database], env))
      .trim()
      .split("\n")
      .map((line) => Number(line.split(":")[2]));
    for (const range of selected) {
      assert.ok(
        identities.every(
          (id) => Number.isSafeInteger(id) && (id < range.first || id >= range.first + range.count),
        ),
        "rootless prerequisite: subordinate IDs collide with host identities (CVE-2024-56433)",
      );
      assert.ok(
        ranges.every((line) => {
          const [name, first, count] = line.split(":");
          return (
            name === user.username ||
            name === String(user.uid) ||
            Number(first) + Number(count) <= range.first ||
            Number(first) >= range.first + range.count
          );
        }),
        "rootless prerequisite: subordinate allocations overlap another user",
      );
    }
    allocated.push(selected);
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
  return allocated;
}

async function main(): Promise<void> {
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
  let allocated: IdRange[][] = [];
  assert.equal(policy.docker.version, "29.9.3");
  assert.equal(policy.docker.buildkit, "0.34.2");
  assert.equal(
    policy.docker.url,
    "https://download.docker.com/linux/static/stable/x86_64/docker-29.9.3.tgz",
  );
  await mkdir(resolve(repository, "dist/toolchain"), { recursive: true });
  const directory = await mkdtemp(
    resolve(repository, `dist/toolchain/docker-${rootless ? "rootless" : "rootful"}-`),
  );
  assert.match(
    directory,
    /^\/[A-Za-z0-9_./-]+$/,
    "Docker prerequisite: simple absolute checkout path",
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
      if (name !== "dockerd-rootless.sh") continue; // Reject the old-Go binary; no setuptool installer.
      await writeFile(resolve(directory, name), bytes, { mode: 0o755 });
    }
    await prepareRootlesskit(directory);
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
  // Both modes use fresh private state and never inherit Docker credentials or daemon config.
  const session = await mkdtemp(resolve(tmpdir(), "fortipi-docker-"));
  assert.match(
    session,
    /^\/[A-Za-z0-9_./-]+$/,
    "Docker prerequisite: simple absolute temporary path",
  );
  const config = resolve(session, "config");
  await mkdir(plugins, { mode: 0o700 });
  await mkdir(config, { mode: 0o700 });
  for (const path of [directory, session, plugins, config]) {
    const stat = await lstat(path);
    assert.ok(
      stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700,
      "Docker tooling/state must be private job-owned 0700 directories",
    );
  }
  const buildx = await download(
    policy.buildx.url,
    policy.buildx.sha256,
    "buildx-v0.38.2.linux-amd64",
  );
  await writeFile(resolve(plugins, "docker-buildx"), buildx);
  await chmod(resolve(plugins, "docker-buildx"), 0o755);
  await writeFile(
    resolve(config, "config.json"),
    JSON.stringify({ cliPluginsExtraDirs: [plugins] }),
    { mode: 0o600 },
  );
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    LANG: process.env.LANG,
    PATH: `${directory}${delimiter}/usr/bin:/bin:/usr/sbin:/sbin`,
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
      allocated = await rootlessPrerequisites(directory, env);
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
    assert.match(
      await command(resolve(directory, name), ["--version"], env),
      /\b29\.9\.3(?:,|\s|$)/,
    );
  if (!rootless) {
    // Harden-Runner normally adds this protected DNS proxy to the system daemon's
    // config. Preserve it explicitly while retaining our empty, isolated config.
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    resolver.setServers(["172.17.0.1"]);
    const allowed = await resolver.resolve4("registry.npmjs.org");
    assert.ok(
      allowed.length > 0 && allowed.every(isIPv4) && !allowed.includes("54.185.253.63"),
      "Protected Docker DNS must resolve the allowed registry",
    );
    assert.deepEqual(
      await resolver.resolve4("example.com"),
      ["54.185.253.63"],
      "Protected Docker DNS must return Harden-Runner's denied-domain sinkhole",
    );
    console.log(
      "Rootful protected Docker DNS allowed/blocked controls verified before daemon replacement",
    );
  }
  await command("sudo", ["-n", "systemctl", "stop", "docker.service", "docker.socket"], env);
  const log = await open(resolve(session, "daemon.log"), "wx", 0o600);
  const daemonConfig = resolve(config, "daemon.json");
  await writeFile(daemonConfig, "{}\n", { mode: 0o600 });
  const daemonArguments = [
    ...(rootless ? ["--rootless", "--storage-driver", "overlay2"] : ["--dns", "172.17.0.1"]),
    "--config-file",
    daemonConfig,
    "--log-level",
    "error",
    "--metrics-addr=",
    "--host",
    `unix://${session}/docker.sock`,
    "--data-root",
    `${session}/data`,
    "--exec-root",
    `${session}/exec`,
    "--pidfile",
    `${session}/daemon.pid`,
  ];
  const daemon = spawn(
    rootless ? resolve(directory, "dockerd-rootless.sh") : "sudo",
    [...(rootless ? [] : ["-n", resolve(directory, "dockerd")]), ...daemonArguments],
    { env, detached: true, stdio: ["ignore", log.fd, log.fd] },
  );
  let stopped: string | undefined;
  daemon.once("error", () => {
    stopped = "spawn error";
  });
  daemon.once("exit", (code, signal) => {
    stopped = `exit ${signal ?? code}`;
  });
  daemon.unref();
  await log.close();
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
        ? `rootless prerequisite: pinned nonroot daemon unavailable (${stopped ?? "60s deadline"}); inspect private ${session}/daemon.log`
        : `Pinned Docker daemon failed; inspect private ${session}/daemon.log`,
    );
    const pid = (await readFile(resolve(session, "daemon.pid"), "utf8")).trim();
    assert.match(pid, /^[1-9]\d*$/);
    assert.ok(
      JSON.stringify(
        (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean),
      ) === JSON.stringify([resolve(directory, "dockerd"), ...daemonArguments]),
      "Daemon arguments must select only the private Unix API, empty config and disabled metrics",
    );
    assert.ok((await readFile(daemonConfig, "utf8")) === "{}\n", "Daemon config must remain empty");
    assert.equal(
      (
        await command(resolve(directory, "docker"), ["info", "--format", "{{.DockerRootDir}}"], env)
      ).trim(),
      resolve(session, "data"),
      "Client must reach this run's isolated daemon",
    );
    const socket = await lstat(resolve(session, "docker.sock"));
    assert.ok(
      socket.isSocket() &&
        socket.uid === (rootless ? process.getuid?.() : 0) &&
        (socket.mode & 0o007) === 0,
      "API socket must be local, correctly owned and inaccessible to other users",
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
      assert.equal(
        (
          await command(
            resolve(directory, "docker"),
            ["info", "--format", "{{.CgroupDriver}}/{{.CgroupVersion}}"],
            env,
          )
        ).trim(),
        "systemd/2",
        "Rootless daemon must retain actual systemd/cgroup v2 enforcement",
      );
      // RootlessKit's child is a supervisor which starts and waits for dockerd.
      const child = (await readFile(resolve(session, "state/child_pid"), "utf8")).trim();
      assert.match(child, /^[1-9]\d*$/);
      for (const processId of [String(daemon.pid), child, pid]) {
        const status = await readFile(`/proc/${processId}/status`, "utf8");
        const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
        assert.ok(
          uids?.slice(1).every((uid) => Number(uid) === process.getuid?.()),
          "RootlessKit and dockerd must run as the nonroot job user on the host",
        );
        if (processId === child)
          assert.equal(
            /^PPid:\s+(\d+)$/m.exec(status)?.[1],
            String(daemon.pid),
            "RootlessKit supervisor ancestry changed",
          );
        if (processId === pid)
          assert.equal(
            /^PPid:\s+(\d+)$/m.exec(status)?.[1],
            child,
            "Daemon must be the actual RootlessKit supervisor's child",
          );
      }
      assert.equal(await realpath(`/proc/${daemon.pid}/exe`), resolve(directory, "rootlesskit"));
      assert.equal(await realpath(`/proc/${child}/exe`), resolve(directory, "rootlesskit"));
      assert.equal(await realpath(`/proc/${pid}/exe`), resolve(directory, "dockerd"));
      assert.equal(
        await readlink(`/proc/${child}/ns/user`),
        await readlink(`/proc/${pid}/ns/user`),
        "Daemon must share its supervisor's user namespace",
      );
      assert.ok(allocated[0] && allocated[1]);
      verifyIdMap(await readFile(`/proc/${pid}/uid_map`, "utf8"), userInfo().uid, allocated[0]);
      verifyIdMap(await readFile(`/proc/${pid}/gid_map`, "utf8"), userInfo().gid, allocated[1]);
    } else {
      assert.equal(
        (await command("/usr/bin/sudo", ["-n", "readlink", "-f", `/proc/${pid}/exe`], env)).trim(),
        resolve(directory, "dockerd"),
        "Rootful daemon executable changed",
      );
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      assert.match(status, /^Uid:\s+0\s+0\s+0\s+0$/m, "Default mode must remain actually rootful");
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
    // Only a bounded startup tail, from the credential-free child environment.
    const diagnostics = await open(resolve(session, "daemon.log"), "r");
    try {
      const size = (await diagnostics.stat()).size;
      const tail = Buffer.alloc(Math.min(size, 16 * 1024));
      await diagnostics.read(tail, 0, tail.length, Math.max(0, size - tail.length));
      await writeFile(resolve(session, "startup-diagnostics.txt"), tail, { mode: 0o600 });
      console.error(
        `Bounded daemon startup diagnostics: ${resolve(session, "startup-diagnostics.txt")}`,
      );
      console.error(tail.toString("utf8"));
    } finally {
      await diagnostics.close();
    }
    if (rootless && daemon.pid) {
      try {
        process.kill(-daemon.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          process.kill(-daemon.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          throw error;
        }
        await new Promise((accept) => setTimeout(accept, 100));
      }
      try {
        process.kill(-daemon.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    throw error;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
