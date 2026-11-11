import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { paragraphs } from "./debian.ts";
import { sha256 } from "./fuse-security.ts";
import { type FilePolicy, rootPath, scanRootfs } from "./rootfs.ts";

export interface PrunePolicy {
  removed: { name: string; version: string }[];
  executables: {
    path: string;
    sha256: string;
    elf: boolean;
    size: number;
    mode: number;
    uid: number;
    gid: number;
  }[];
  aliases: string[];
  forbiddenLayers: string[];
}
export const runtimeEnvironment = [
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "PORT=8080",
  "MOUNT_POINT=/workspace",
  "FUSE_MOUNT=auto",
];
export interface ImageConfig {
  Env?: string[];
  User?: string;
  WorkingDir?: string;
  Entrypoint?: string[];
  Cmd?: string[] | null;
  StopSignal?: string;
  ExposedPorts?: Record<string, unknown>;
  Shell?: string[];
  Volumes?: unknown;
  Labels?: unknown;
}
export function assertRuntimeConfig(config: ImageConfig): void {
  assert.ok(
    JSON.stringify(config.Env?.slice().sort()) ===
      JSON.stringify(runtimeEnvironment.slice().sort()),
    "Runtime ENV changed",
  );
  assert.ok(config.User === "0:0" && config.WorkingDir === "/", "Runtime user/workdir changed");
  assert.ok(
    JSON.stringify(config.Entrypoint) === '["/usr/local/bin/computerd"]',
    "Runtime entrypoint changed",
  );
  assert.ok((config.Cmd ?? []).length === 0, "Runtime command changed");
  assert.ok(config.StopSignal === "SIGTERM", "Runtime stop signal changed");
  assert.ok(
    JSON.stringify(Object.keys(config.ExposedPorts ?? {})) === '["8080/tcp"]',
    "Runtime exposed port changed",
  );
  assert.ok(
    config.Shell === undefined || JSON.stringify(config.Shell) === '["/bin/sh","-c"]',
    "Runtime default shell changed",
  );
  for (const [field, value] of [
    ["volumes", config.Volumes],
    ["labels", config.Labels],
  ])
    assert.ok(
      value === undefined ||
        value === null ||
        (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0),
      `Unexpected runtime image ${field}`,
    );
}
/** Re-derive removed executable identities from the hash-verified public input, not assessment evidence. */
export async function pruningPolicy(
  layer: string,
  layerDigest: string,
  configuration: string,
  configurationDigest: string,
): Promise<PrunePolicy> {
  assert.equal(
    `sha256:${sha256(await readFile(layer))}`,
    layerDigest,
    "Pruning input layer changed",
  );
  const bytes = await readFile(configuration);
  assert.equal(`sha256:${sha256(bytes)}`, configurationDigest, "Pruning input config changed");
  const config = JSON.parse(bytes.toString("utf8")) as {
    config: ImageConfig;
    rootfs: { diff_ids: string[] };
  };
  assert.ok(
    JSON.stringify(config.config.Env) === JSON.stringify([runtimeEnvironment[0]]),
    "Review changed inherited runtime PATH",
  );
  assert.ok(
    !config.config.User &&
      !config.config.WorkingDir &&
      (config.config.Entrypoint ?? []).length === 0 &&
      !config.config.StopSignal,
    "Review changed Debian runtime defaults",
  );
  assert.ok(
    JSON.stringify(config.config.Cmd) === '["bash"]',
    "Review changed Debian command default",
  );
  assert.equal(config.rootfs.diff_ids.length, 1, "Review changed base layer graph");
  const captures = new Set([
    "var/lib/dpkg/status",
    "var/lib/dpkg/info/apt.list",
    "var/lib/dpkg/info/sqv.list",
  ]);
  const files = await pipeline(createReadStream(layer), createGunzip(), async (source) =>
    scanRootfs(source, undefined, captures),
  );
  const status = files.get("var/lib/dpkg/status")?.data;
  assert.ok(status);
  const installed = paragraphs(status.toString("utf8")).filter(
    (row) => row.get("Status") === "install ok installed",
  );
  assert.equal(installed.length, 78, "Changed base input package inventory");
  const removed: PrunePolicy["removed"] = [],
    executables: PrunePolicy["executables"] = [],
    aliases: string[] = [];
  for (const name of ["apt", "sqv"]) {
    const row = installed.find((row) => row.get("Package") === name);
    assert.ok(
      row && row.get("Essential") !== "yes" && row.get("Protected") !== "yes",
      "Removed package became Essential/Protected",
    );
    removed.push({ name, version: row.get("Version") ?? "" });
    const list = files.get(`var/lib/dpkg/info/${name}.list`)?.data;
    assert.ok(list);
    for (const path of list
      .toString("utf8")
      .trim()
      .split("\n")
      .map((path) => rootPath(path.replace(/^\//, "")))) {
      const entry = files.get(path);
      if (entry?.type === "SymbolicLink" || entry?.type === "Link") aliases.push(path);
      if (entry?.type === "File" && entry.mode & 0o111) {
        assert.ok(entry.sha256);
        executables.push({
          path,
          sha256: entry.sha256,
          elf: entry.elf ?? false,
          size: entry.size,
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
        });
      }
    }
  }
  assert.equal(executables.length, 25, "Changed removed executable inventory");
  assert.equal(executables.filter((file) => file.elf).length, 19, "Changed removed ELF inventory");
  return {
    removed,
    executables: executables.sort((a, b) => a.path.localeCompare(b.path)),
    aliases: aliases.sort(),
    forbiddenLayers: [layerDigest, ...config.rootfs.diff_ids],
  };
}
export function filePolicy(policy: PrunePolicy): FilePolicy {
  return {
    paths: new Set([...policy.executables.map((file) => file.path), ...policy.aliases]),
    hashes: new Set([
      ...policy.executables.filter((file) => file.elf).map((file) => file.sha256),
      ...policy.forbiddenLayers.map((digest) => digest.replace(/^sha256:/, "")),
    ]),
  };
}
