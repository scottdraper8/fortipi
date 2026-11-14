// CI-only Linux image tooling. No product bytes or credentials enter this directory.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import { repository } from "../../scripts/build-workspaces.ts";
import { json } from "../../scripts/check-pins.ts";
import { archiveEntries, hash } from "./review-supply-chain.ts";

assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.ok(
  process.env.GITHUB_PATH && process.env.GITHUB_ENV,
  "This provisioner is only for isolated GitHub Linux runners",
);
const policy = await json<{
  docker: { url: string; sha256: string; version: string };
  buildx: {
    url: string;
    sha256: string;
    version: string;
    source: string;
    licensePath: string;
    licenseSha256: string;
  };
}>(repository, "tools/unstale/platform-tools.json");
assert.equal(policy.docker.version, "29.9.3");
assert.equal(
  policy.docker.url,
  "https://download.docker.com/linux/static/stable/x86_64/docker-29.9.3.tgz",
);
const directory = resolve(repository, "dist/toolchain/docker");
await mkdir(directory, { recursive: true });
const archive = resolve(repository, "dist/toolchain/docker-29.9.3.tgz");
let raw: Buffer;
let downloaded = false;
try {
  raw = await readFile(archive);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  const response = await fetch(policy.docker.url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok);
  raw = Buffer.from(await response.arrayBuffer());
  downloaded = true;
}
assert.equal(hash(raw), policy.docker.sha256, "Docker archive identity changed");
// The rootless launcher independently checks its daemon against this exact archive.
if (downloaded) await writeFile(archive, raw, { flag: "wx", mode: 0o600 });
for (const [path, bytes] of archiveEntries(raw)) {
  assert.match(path, /^docker\/[a-z0-9-]+$/);
  const target = resolve(directory, basename(path));
  await writeFile(target, bytes);
  await chmod(target, 0o755);
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
const config = resolve(directory, "config");
await mkdir(plugins, { recursive: true });
await mkdir(config, { recursive: true });
let buildx: Buffer;
try {
  buildx = await readFile(resolve(repository, "dist/toolchain/buildx-v0.38.2.linux-amd64"));
} catch {
  const response = await fetch(policy.buildx.url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok);
  buildx = Buffer.from(await response.arrayBuffer());
}
assert.equal(hash(buildx), policy.buildx.sha256, "Buildx archive identity changed");
await writeFile(resolve(plugins, "docker-buildx"), buildx);
await chmod(resolve(plugins, "docker-buildx"), 0o755);
await writeFile(resolve(config, "config.json"), JSON.stringify({ cliPluginsExtraDirs: [plugins] }));
const exec = promisify(execFile);
const env = {
  ...process.env,
  PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
  DOCKER_HOST: `unix://${directory}/docker.sock`,
  DOCKER_CONFIG: config,
  BUILDX_BUILDER: "default",
};
for (const name of ["docker", "dockerd"])
  assert.match(
    (await exec(resolve(directory, name), ["--version"], { env, timeout: 30_000 })).stdout,
    /29\.9\.3/,
  );
await exec("sudo", ["-n", "systemctl", "stop", "docker.service", "docker.socket"], {
  env,
  timeout: 30_000,
});
const log = await open(resolve(directory, "daemon.log"), "w");
const daemon = spawn(
  "sudo",
  [
    "-n",
    resolve(directory, "dockerd"),
    "--host",
    env.DOCKER_HOST,
    "--data-root",
    `${directory}/data`,
    "--exec-root",
    `${directory}/exec`,
    "--pidfile",
    `${directory}/daemon.pid`,
  ],
  { env, detached: true, stdio: ["ignore", log.fd, log.fd] },
);
daemon.unref();
await log.close();
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    assert.equal(
      (
        await exec(resolve(directory, "docker"), ["version", "--format", "{{.Server.Version}}"], {
          env,
          timeout: 3_000,
        })
      ).stdout.trim(),
      "29.9.3",
    );
    ready = true;
    break;
  } catch {
    await new Promise((accept) => setTimeout(accept, 500));
  }
}
assert.ok(ready, "Pinned Docker daemon failed; inspect ignored daemon.log");
const activeBuildx = (
  await exec(resolve(directory, "docker"), ["buildx", "version"], { env, timeout: 30_000 })
).stdout.trim();
const identity = /^github\.com\/docker\/buildx v(\d+\.\d+\.\d+) ([a-f0-9]{7,40})$/.exec(
  activeBuildx,
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
  `DOCKER_HOST=${env.DOCKER_HOST}\nDOCKER_CONFIG=${config}\nBUILDX_BUILDER=default\n`,
  { flag: "a" },
);
console.log(
  "Docker CLI/Engine 29.9.3 and Buildx 0.38.2 verified on isolated Linux runner; actual image/FUSE evidence is still required",
);
