// One actual fixture invocation; rootless workerd shares the verified daemon topology.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { resolve4 } from "node:dns/promises";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { repository } from "../../scripts/build-workspaces.ts";
import { archiveEntries, hash } from "./review-supply-chain.ts";
import { isStepSecuritySinkhole, verifyControls } from "./verify-container-egress.ts";

const execute = promisify(execFile);
const fixture = resolve(repository, "apps/worker/test/backends/linux-image.ts");
const self = resolve(repository, "tools/unstale/run-container-probe.ts");
const env = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  DOCKER_HOST: process.env.DOCKER_HOST,
  DOCKER_CONFIG: process.env.DOCKER_CONFIG,
  BUILDX_CONFIG: process.env.BUILDX_CONFIG,
  BUILDX_BUILDER: "default",
  CI: "true",
  WRANGLER_SEND_METRICS: "false",
};

async function rootlessContext(inside: boolean): Promise<string> {
  assert.equal(process.platform, "linux");
  const uid = process.getuid?.();
  assert.ok(uid !== undefined && (inside ? uid === 0 : uid > 0));
  assert.match(
    env.DOCKER_HOST ?? "",
    /^unix:\/\/\/tmp\/fortipi-docker-[A-Za-z0-9_-]+\/docker.sock$/,
  );
  const socket = (env.DOCKER_HOST ?? "").slice("unix://".length);
  const session = dirname(socket);
  assert.equal(env.DOCKER_CONFIG, resolve(session, "config"));
  for (const directory of [session, env.DOCKER_CONFIG]) {
    const stat = await lstat(directory);
    assert.ok(stat.isDirectory() && stat.uid === uid && (stat.mode & 0o777) === 0o700);
  }
  const api = await lstat(socket);
  assert.ok(api.isSocket() && api.uid === uid && (api.mode & 0o007) === 0);
  const pid = (await readFile(resolve(session, "daemon.pid"), "utf8")).trim();
  const supervisor = (await readFile(resolve(session, "state/child_pid"), "utf8")).trim();
  for (const value of [pid, supervisor]) assert.match(value, /^[1-9][0-9]*$/);
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  assert.equal(/^PPid:\s+([0-9]+)$/m.exec(status)?.[1], supervisor);
  const policy = JSON.parse(
    await readFile(resolve(repository, "tools/unstale/platform-tools.json"), "utf8"),
  ) as {
    docker: { sha256: string };
    rootless: { rootlesskit: { binarySha256: string } };
  };
  const archive = await readFile(resolve(repository, "dist/toolchain/docker-29.9.3.tgz"));
  assert.equal(hash(archive), policy.docker.sha256);
  const expected = archiveEntries(archive).get("docker/dockerd");
  assert.ok(expected);
  assert.equal(hash(await readFile(`/proc/${pid}/exe`)), hash(expected));
  assert.equal(
    hash(await readFile(`/proc/${supervisor}/exe`)),
    policy.rootless.rootlesskit.binarySha256,
  );
  const parentStatus = await readFile(`/proc/${supervisor}/status`, "utf8");
  const outer = /^PPid:\s+([0-9]+)$/m.exec(parentStatus)?.[1];
  assert.ok(outer && /^[1-9][0-9]*$/.test(outer));
  for (const observed of [status, parentStatus])
    assert.ok(
      /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/m
        .exec(observed)
        ?.slice(1)
        .every((v) => Number(v) === uid),
    );
  if (!inside) {
    assert.equal(
      hash(await readFile(`/proc/${outer}/exe`)),
      policy.rootless.rootlesskit.binarySha256,
    );
    const rootlessArgs = (await readFile(`/proc/${outer}/cmdline`, "utf8")).split("\0");
    assert.ok(rootlessArgs.includes("--disable-host-loopback"));
    const outerStatus = await readFile(`/proc/${outer}/status`, "utf8");
    assert.ok(
      /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/m
        .exec(outerStatus)
        ?.slice(1)
        .every((v) => Number(v) === uid),
    );
  }
  const daemonArgs = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
  assert.ok(daemonArgs.includes(`unix://${socket}`) && daemonArgs.includes("--rootless"));
  const executable = await realpath(`/proc/${pid}/exe`);
  assert.ok(
    executable.startsWith(resolve(repository, "dist/toolchain/docker-rootless-")) &&
      executable.endsWith("/dockerd"),
  );
  const tools = await lstat(dirname(executable));
  assert.ok(tools.isDirectory() && tools.uid === uid && (tools.mode & 0o777) === 0o700);
  for (const kind of ["user", "net", "mnt"]) {
    const target = await readlink(`/proc/${pid}/ns/${kind}`);
    if (kind !== "mnt") assert.equal(target, await readlink(`/proc/${supervisor}/ns/${kind}`));
    const current = await readlink(`/proc/self/ns/${kind}`);
    if (inside) assert.equal(current, target);
    else assert.notEqual(current, target);
  }
  for (const kind of ["uid", "gid"]) {
    const mapping = await readFile(`/proc/${pid}/${kind}_map`, "utf8");
    if (inside) assert.equal(await readFile(`/proc/self/${kind}_map`, "utf8"), mapping);
    else {
      const first = mapping.trim().split("\n")[0]?.trim().split(/\s+/).map(Number);
      assert.deepEqual(first, [0, kind === "uid" ? uid : process.getgid?.(), 1]);
    }
  }
  const security = JSON.parse(
    (
      await execute("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
        env,
        timeout: 5000,
        maxBuffer: 16384,
        encoding: "utf8",
      })
    ).stdout,
  ) as string[];
  assert.ok(security.includes("name=rootless"));
  console.log(
    JSON.stringify({
      probe: "rootless-runtime-context",
      inside,
      privateApiVerified: true,
      daemonNamespacesVerified: true,
      uidMapsVerified: true,
      ...(inside ? {} : { hostLoopbackDisabled: true }),
    }),
  );
  return pid;
}

async function namespaceEgress(): Promise<void> {
  const allowed = async () => {
    const response = await fetch("https://registry.npmjs.org/pnpm/12.18.0", {
      signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    return response.status === 200 ? 0 : 1;
  };
  const before = await allowed();
  let denied = 0;
  try {
    const response = await fetch("https://example.com", { signal: AbortSignal.timeout(10000) });
    await response.body?.cancel();
  } catch {
    denied = 1;
  }
  const after = await allowed();
  verifyControls(before, denied, after);
  assert.ok(isStepSecuritySinkhole(await resolve4("example.com")));
  console.log(
    JSON.stringify({
      probe: "runtime-namespace-egress",
      allowedControls: "connected",
      exampleConnection: "refused",
      stepSecuritySinkhole: true,
    }),
  );
}

if (import.meta.main) {
  assert.equal(process.platform, "linux");
  assert.match(
    env.DOCKER_HOST ?? "",
    /^unix:\/\/\/tmp\/fortipi-docker-[A-Za-z0-9_-]+\/docker.sock$/,
  );
  assert.equal(
    env.DOCKER_CONFIG,
    resolve(dirname((env.DOCKER_HOST ?? "").slice("unix://".length)), "config"),
  );
  assert.ok(
    process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--rootless"),
  );
  const rootless = process.argv[2] === "--rootless";
  const args = [
    "--import",
    resolve(repository, "tools/unstale/container-runtime-diagnostics.ts"),
    fixture,
  ];
  if (rootless) {
    const pid = await rootlessContext(false);
    args.unshift("--import", self);
    args.push("--require-fuse");
    args.unshift(
      "--user",
      "--preserve-credentials",
      "--net",
      "--mount",
      "--target",
      pid,
      "--",
      process.execPath,
    );
  }
  const child = spawn(rootless ? "/usr/bin/nsenter" : process.execPath, args, {
    cwd: repository,
    env,
    stdio: "inherit",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 180000);
  await new Promise<void>((accept, reject) => {
    child.once("error", () => {
      clearTimeout(deadline);
      reject(new Error("Container fixture launcher failed"));
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      if (code === 0) accept();
      else reject(new Error("Container fixture failed"));
    });
  });
} else if (process.platform === "linux" && process.argv[1] === fixture) {
  await rootlessContext(true);
  await namespaceEgress();
}
