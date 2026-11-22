// Node builtins only: the first checkpoint runs before dependency installation.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const invalid = () => new Error("Invalid Git cleanliness data");
const pathLimit = 32;
function nulRecords(value: string): string[] {
  if (value === "") return [];
  if (!value.endsWith("\0")) throw invalid();
  const records = value.slice(0, -1).split("\0");
  if (records.some((record) => !record)) throw invalid();
  return records;
}
function canonical(path: string): boolean {
  return (
    path.length > 0 &&
    !/[\p{Cc}\\:]/u.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Porcelain v1 -z puts the destination before the additional rename/copy origin. */
export function projectEvidenceBuildCleanliness(inventory: string, status: string) {
  const listed = nulRecords(inventory);
  if (listed.some((path) => !canonical(path))) throw invalid();
  const known = new Set(listed);
  if (known.size !== listed.length) throw invalid();
  const records = nulRecords(status),
    paths: { status: string; path: string }[] = [];
  let entries = 0,
    unlistedPaths = 0,
    omittedPaths = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record[2] !== " ") throw invalid();
    const code = record.slice(0, 2);
    if (
      !/^(?:\?\?|[ MTADRCU]{2})$/.test(code) ||
      code === "  " ||
      (code.includes("U") && !["AU", "UD", "UA", "DU", "UU"].includes(code))
    )
      throw invalid();
    const names = [record.slice(3)];
    if (/[RC]/.test(code)) {
      const origin = records[++index];
      if (!origin) throw invalid();
      names.push(origin);
    }
    entries++;
    for (const path of names) {
      // --untracked-files=normal can report a whole directory with a trailing slash.
      if (!canonical(code === "??" && path.endsWith("/") ? path.slice(0, -1) : path))
        throw invalid();
      if (!known.has(path)) unlistedPaths++;
      else if (path.length > 512 || !/^[A-Za-z0-9_./@+-]+$/.test(path)) omittedPaths++;
      else paths.push({ status: code, path });
    }
  }
  paths.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.status < b.status ? -1 : a.status > b.status ? 1 : 0;
  });
  return {
    dirty: entries > 0,
    entries,
    unlistedPaths,
    omittedPaths: omittedPaths + Math.max(0, paths.length - pathLimit),
    paths: paths.slice(0, pathLimit),
  };
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("No arguments are supported");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    execute = promisify(execFile);
  // Keep child output in memory: the shared run() inherits raw child stdio.
  const command = async (
    file: string,
    args: string[],
    timeout = 20000,
    env: NodeJS.ProcessEnv = process.env,
  ) =>
    (
      await execute(file, args, {
        cwd: root,
        encoding: "utf8",
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env,
      })
    ).stdout;
  // Match the release checkout guard, including its restricted Git environment.
  const git = (args: string[]) =>
    command("git", args, 20000, {
      PATH: process.env.PATH,
      Path: process.env.Path,
      SystemRoot: process.env.SystemRoot,
      LANG: "C",
    });
  const head = (await git(["rev-parse", "--verify", "HEAD"])).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw invalid();
  const inventory = await git(["ls-tree", "-rz", "--name-only", head]);
  async function checkpoint(stage: string, commandFailed = false) {
    const sameHead = (await git(["rev-parse", "--verify", "HEAD"])).trim() === head;
    const observation = projectEvidenceBuildCleanliness(
      inventory,
      await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    );
    const status = !sameHead
      ? "head-changed"
      : observation.dirty
        ? "dirty"
        : commandFailed
          ? "command-failed"
          : "clean";
    const line =
      JSON.stringify({
        diagnostic: "evidence-build-cleanliness",
        checkpoint: stage,
        sourceCommit: head,
        status,
        commandFailed,
        ...observation,
      }) + "\n";
    await mkdir(resolve(root, "dist"), { recursive: true });
    await writeFile(resolve(root, "dist/evidence-build-cleanliness.json"), line, { mode: 0o600 });
    process.stdout.write(line);
    if (status !== "clean") throw new Error("Evidence build cleanliness checkpoint failed");
  }
  await checkpoint("baseline");
  for (const [stage, args, timeout] of [
    ["install", ["scripts/install-dependencies.ts"], 660000],
    [
      "contract",
      ["node_modules/typescript/bin/tsc", "-p", "packages/fortipi-contract/tsconfig.json"],
      300000,
    ],
    ["foundation", ["scripts/verify-foundation.ts", "--native"], 180000],
    ["build", ["scripts/build-workspaces.ts", "build:evidence"], 900000],
  ] as const) {
    let commandFailed = false;
    try {
      await command(process.execPath, [...args], timeout);
    } catch {
      commandFailed = true;
    }
    await checkpoint(stage, commandFailed);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error("Evidence build cleanliness check failed");
    process.exitCode = 1;
  }
}
