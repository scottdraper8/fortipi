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
const policy = await json<{ docker: { url: string; sha256: string; version: string } }>(
  repository,
  "tools/unstale/platform-tools.json",
);
assert.equal(policy.docker.version, "29.9.3");
assert.equal(
  policy.docker.url,
  "https://download.docker.com/linux/static/stable/x86_64/docker-29.9.3.tgz",
);
const directory = resolve(repository, "dist/toolchain/docker");
await mkdir(directory, { recursive: true });
let raw: Buffer;
try {
  raw = await readFile(resolve(repository, "dist/toolchain/docker-29.9.3.tgz"));
} catch {
  const response = await fetch(policy.docker.url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok);
  raw = Buffer.from(await response.arrayBuffer());
}
assert.equal(hash(raw), policy.docker.sha256, "Docker archive identity changed");
for (const [path, bytes] of archiveEntries(raw)) {
  assert.match(path, /^docker\/[a-z0-9-]+$/);
  const target = resolve(directory, basename(path));
  await writeFile(target, bytes);
  await chmod(target, 0o755);
}
const exec = promisify(execFile);
const env = {
  ...process.env,
  PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
  DOCKER_HOST: `unix://${directory}/docker.sock`,
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
await writeFile(process.env.GITHUB_PATH, `${directory}\n`, { flag: "a" });
await writeFile(process.env.GITHUB_ENV, `DOCKER_HOST=${env.DOCKER_HOST}\n`, { flag: "a" });
console.log(
  "Docker CLI and Engine 29.9.3 verified on isolated Linux runner; actual image/FUSE evidence is still required",
);
