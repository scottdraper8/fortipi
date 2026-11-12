import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execute } from "../../scripts/prepare-release.ts";
import type { CandidateManifest } from "../../scripts/verify-release-gates.ts";

export async function runtimeImports(candidate: CandidateManifest, consumer: string) {
  const exports = candidate.packages.map((p) => p.name);
  exports.push(
    `@${candidate.scope}/fortipi-client/browser`,
    `@${candidate.scope}/fortipi-client/node`,
  );
  const resolution = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(exports)}.map(name=>[name,import.meta.resolve(name)]))))`,
    ],
    consumer,
    {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    },
    15000,
  );
  assert.ok(
    resolution.code === 0 && !resolution.timedOut,
    "Native installed ESM exports must resolve in the consumer",
  );
  const resolved = JSON.parse(resolution.stdout) as Record<string, string>;
  const resolveExport = (name: string) => {
    assert.ok(exports.includes(name) && resolved[name]);
    return fileURLToPath(resolved[name]!);
  };
  for (const name of exports) {
    const path = resolveExport(name);
    assert.ok((await realpath(path)).startsWith(`${consumer}${sep}node_modules${sep}`));
    const loaded = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    assert.ok(Object.keys(loaded).length > 0, "Installed public module must have real exports");
  }
  const bins: Record<string, string> = {};
  for (const pkg of candidate.packages) {
    const manifest = JSON.parse(
      await readFile(resolve(consumer, "node_modules", pkg.name, "package.json"), "utf8"),
    );
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      assert.ok(
        !name.startsWith("fortipi-"),
        "No unscoped own imports/dependencies in installed distribution",
      );
      if (name.startsWith(`@${candidate.scope}/fortipi-`)) assert.equal(version, candidate.version);
    }
    for (const [name, path] of Object.entries(manifest.bin ?? {}) as [string, string][]) {
      const bin = resolve(consumer, "node_modules", pkg.name, path);
      assert.ok(bin.startsWith(`${resolve(consumer, "node_modules", pkg.name)}${sep}`));
      assert.ok((await readFile(bin, "utf8")).startsWith("#!/usr/bin/env node\n"));
      assert.ok(!bins[name], "Candidate bin collision");
      bins[name] = bin;
    }
  }
  const cliRoot = resolve(consumer, "node_modules", `@${candidate.scope}/fortipi-cli`);
  const tools = createRequire(resolve(cliRoot, "package.json"));
  const wranglerManifest = tools.resolve("wrangler/package.json");
  const wrangler = JSON.parse(await readFile(wranglerManifest, "utf8"));
  assert.equal(
    wrangler.version,
    JSON.parse(await readFile(resolve(cliRoot, "package.json"), "utf8")).dependencies.wrangler,
  );
  return {
    resolveExport,
    bins,
    cliRoot,
    wranglerBin: resolve(dirname(wranglerManifest), wrangler.bin.wrangler),
    exports,
  };
}
