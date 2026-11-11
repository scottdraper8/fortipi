import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { archive, archiveEntries, hash } from "../tools/unstale/review-supply-chain.ts";
import { repository } from "./build-workspaces.ts";
import type { SupplyChain } from "./check-pins.ts";

export function validateRejectedZodAuthorities(cve: unknown, github: unknown): void {
  const authority = cve as { cveMetadata: { cveId: string; state: string } };
  const advisory = github as {
    ghsa_id: string;
    cve_id: string;
    withdrawn_at: string | null;
    vulnerabilities: {
      package: { ecosystem: string; name: string };
      vulnerable_version_range: string;
      first_patched_version: string;
    }[];
  };
  assert.equal(authority.cveMetadata.cveId, "CVE-2023-54404");
  assert.equal(authority.cveMetadata.state, "REJECTED", "CVE status changed");
  assert.equal(advisory.ghsa_id, "GHSA-mrhx-c7xc-m3w5");
  assert.equal(advisory.cve_id, "CVE-2023-54404");
  assert.equal(advisory.withdrawn_at, null, "GHSA assessment changed");
  assert.equal(advisory.vulnerabilities.length, 1, "GHSA affected-version assessment changed");
  const vulnerability = advisory.vulnerabilities[0];
  assert.ok(vulnerability);
  assert.deepEqual(vulnerability.package, { ecosystem: "npm", name: "zod" });
  assert.equal(vulnerability.vulnerable_version_range, "< 4.6.6");
  assert.equal(vulnerability.first_patched_version, "4.6.6");
}

export async function rejectedZodAdvisory(output: string): Promise<boolean> {
  if (
    !/1 of 1 advisory on \d+ locked package versions/.test(output) ||
    !/^\s+zod 4\.6\.7 \(direct\):$/m.test(output)
  )
    return false;
  const packages = [...output.matchAll(/^\s+\S+ \S+ \([^\n)]*\):\s*$/gm)];
  if (packages.length !== 1 || packages[0]?.[0].trim() !== "zod 4.6.7 (direct):") return false;
  const ids = [...output.matchAll(/(?:CVE-\d{4}-\d+|GHSA-[a-z0-9-]+)/g)].map((m) => m[0]);
  if (!ids.length || ids.some((id) => !["CVE-2023-54404", "GHSA-mrhx-c7xc-m3w5"].includes(id)))
    return false;
  const disposition = await json<{
    package: string;
    version: string;
    cve: string;
    authorityURL: string;
    githubURL: string;
  }>(repository, "tools/unstale/advisory-disposition.json");
  assert.equal(disposition.package, "zod");
  assert.equal(disposition.version, "4.6.7");
  assert.equal(disposition.cve, "CVE-2023-54404");
  assert.equal(
    disposition.authorityURL,
    "https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2023/54xxx/CVE-2023-54404.json",
  );
  assert.equal(disposition.githubURL, "https://api.github.com/advisories/GHSA-mrhx-c7xc-m3w5");
  const observations: { url: string; sha256: string }[] = [];
  const fetchSource = async (url: string): Promise<unknown> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    assert.ok(response.ok, `Advisory authority unavailable: HTTP ${response.status}`);
    const raw = Buffer.from(await response.arrayBuffer());
    observations.push({ url, sha256: hash(raw) });
    return JSON.parse(raw.toString()) as unknown;
  };
  validateRejectedZodAuthorities(
    await fetchSource(disposition.authorityURL),
    await fetchSource(disposition.githubURL),
  );
  await mkdir(resolve(repository, "dist/supply-chain"), { recursive: true });
  await writeFile(
    resolve(repository, "dist/supply-chain/advisory-disposition.json"),
    `${JSON.stringify({ ...disposition, observedAt: new Date().toISOString(), observations, result: "CVE authority rejects ID; GHSA range excludes pinned 4.6.7; stale Git-only OSV record remains disclosed" }, null, 2)}\n`,
  );
  console.log(
    "unstale CVE-2023-54404/zod4.6.7: current CVE authority REJECTED; current GHSA affects <4.6.6. Exact stale-feed disposition verified; all other actionable findings still block.",
  );
  return true;
}

import { json } from "./check-pins.ts";

async function execute(
  binary: string,
  args: string[],
  timeout = 45_000,
): Promise<{ code: number; output: string }> {
  return new Promise((accept, reject) => {
    // Public registry/catalog queries receive no registry or application credentials.
    const env: NodeJS.ProcessEnv = {};
    env.UNSTALE_CACHE_DIR = resolve(repository, ".unstale/cache");
    for (const key of [
      "PATH",
      "HOME",
      "USERPROFILE",
      "LOCALAPPDATA",
      "APPDATA",
      "SystemRoot",
      "WINDIR",
      "TMPDIR",
      "TEMP",
      "TMP",
      "CI",
    ])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(binary, args, {
      cwd: repository,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    const collect = (data: Buffer): void => {
      output += data.toString();
      if (output.length > 2_000_000) child.kill("SIGKILL");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (timedOut || output.length > 2_000_000)
        reject(
          new Error(
            "unstale timeout/output limit; coverage unavailable; retry after checking service",
          ),
        );
      else accept({ code: code ?? 1, output });
    });
  });
}

async function main(): Promise<void> {
  const key = `${process.platform}-${process.arch}`;
  assert.ok(
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"].includes(key),
    `Unsupported unstale platform ${key}`,
  );
  const name = `@unstale/cli-${key}`;
  const review = await json<SupplyChain>(repository, "tools/unstale/supply-chain.json");
  const record = review.packages[`${name}@0.2.12`];
  assert.ok(record, "Missing unstale native archive review");
  const require = createRequire(resolve(repository, "tools/unstale/package.json"));
  const launcherRequire = createRequire(require.resolve("@unstale/cli/package.json"));
  const manifest = launcherRequire.resolve(`${name}/package.json`);
  const relative = `bin/unstale${process.platform === "win32" ? ".exe" : ""}`;
  const binary = resolve(dirname(manifest), relative);
  const entries = archiveEntries(await archive(name, "0.2.12", record.integrity));
  const expected = entries.get(`package/${relative}`);
  assert.ok(expected, "Missing native unstale binary in reviewed archive");
  assert.equal(
    hash(await readFile(binary)),
    hash(expected),
    "Installed unstale native integrity mismatch",
  );
  assert.equal((await execute(binary, ["--version"])).output.trim(), "unstale 0.2.12");
  let initialized = true;
  try {
    await access(resolve(repository, ".unstale/config.json"));
  } catch {
    initialized = false;
  }
  if (!initialized) {
    const init = await execute(
      binary,
      ["init", "--yes", "--mode", "personal", "--no-animation", "--wait", "0"],
      60_000,
    );
    assert.equal(init.code, 0, `unstale setup failed: ${init.output}`);
  }
  const notify = await execute(binary, ["notify"]);
  assert.equal(notify.code, 0, `unstale notify failed: ${notify.output}`);
  const status = await execute(binary, ["status", "--wait", "10", "--no-animation"], 60_000);
  assert.equal(status.code, 0, `unstale status failed: ${status.output}`);
  await execute(binary, ["sync"], 60_000);
  const advisories = await execute(binary, ["advisories"]);
  assert.equal(advisories.code, 0, `unstale advisory lookup failed: ${advisories.output}`);
  const advisoryUnavailable =
    advisories.output.trim() ===
    "No lockfile advisory report yet: `unstale sync` reads OSV (cached a day).";
  assert.ok(
    !advisories.output.trim() ||
      advisoryUnavailable ||
      /^Lockfile advisories(?: \(.*\))?: 0 of \d+ advisor(?:y|ies) on \d+ locked package versions call for action[^\n]*$/.test(
        advisories.output.trim(),
      ) ||
      (await rejectedZodAdvisory(advisories.output)),
    `Actionable unstale security findings: ${advisories.output}`,
  );
  const report = await readFile(resolve(repository, ".unstale/onboarding-report.md"), "utf8");
  const coverage = await readFile(resolve(repository, ".unstale/state/coverage.json"), "utf8");
  const acknowledged =
    !/no shared coverage acknowledged|no acknowledged public coverage|nothing was checked|no dependencies were read/i.test(
      `${status.output}\n${report}`,
    );
  await mkdir(resolve(repository, "dist/supply-chain"), { recursive: true });
  await writeFile(
    resolve(repository, "dist/supply-chain/unstale.json"),
    `${JSON.stringify({ version: "0.2.12", platform: key, notifyExit: notify.code, statusExit: status.code, advisoryExit: advisories.code, advisoryCoverage: advisoryUnavailable ? "unavailable" : "checked", acknowledged, reportSha256: hash(Buffer.from(report)), coverageSha256: hash(Buffer.from(coverage)), observedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(
    status.output
      .split("\n")
      .filter((line) => /Mapping your stack|Mapped \d+ direct|Coverage ·|Scope ·/.test(line))
      .join("\n"),
  );
  console.log(
    `unstale catalog/coverage: ${acknowledged ? "see saved report for acknowledged and missing packages" : "DEGRADED — no coverage acknowledgment; retry pnpm run unstale:check; exact OSV graph check remains separate"}`,
  );
}

if (import.meta.main) await main();
