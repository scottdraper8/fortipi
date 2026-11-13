// One reviewed tool environment; pip never resolves against an external index.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policyDirectory = resolve(repository, "tools/unstale");
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
interface Archive {
  filename: string;
  url: string;
  size: number;
  sha256: string;
}
interface Package extends Archive {
  name: string;
  version: string;
  requiresPython: string | null;
  requiresDist: string[];
  license: string;
  metadataSha256: string;
  licenses: Record<string, string>;
}
export interface PrecommitLock {
  format: number;
  python: string;
  pip: string;
  reviewedAt: string;
  build: string[];
  runtime: string[];
  hookSource: { commit: string; sha256: string; moduleTreeSha256: string; moduleCount: number };
  supportArchives: Archive[];
  packages: Package[];
}
const own = (uid: number) => process.getuid === undefined || uid === process.getuid();
const safePath = (path: string) => isAbsolute(path) && !/[\r\n\0]/.test(path);
const normalize = (name: string) => name.toLowerCase().replace(/[_.]+/g, "-");
const commands = [
  "pre-commit",
  "check-added-large-files",
  "check-merge-conflict",
  "check-yaml",
  "check-json",
  "check-symlinks",
  "check-case-conflict",
  "detect-private-key",
];

type Stage =
  | "arguments"
  | "lock"
  | "directory"
  | "archives"
  | "interpreter-path"
  | "interpreter-realpath"
  | "interpreter-stat"
  | "interpreter-file"
  | "interpreter-owner"
  | "interpreter-mode"
  | "interpreter-sha256"
  | "interpreter-expected"
  | "interpreter-version-command"
  | "interpreter-version"
  | "interpreter-stable-sha256"
  | "download"
  | "venv"
  | "install-build"
  | "install-runtime"
  | "installed-metadata"
  | "pip-check"
  | "hook-source"
  | "freeze"
  | "identity"
  | "verify"
  | "github-path";
let cliStage: Stage = "arguments";
function stage(value: Stage): void {
  if (import.meta.main) cliStage = value;
}
function safeCode(value: unknown): number | string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)
    return value;
  return typeof value === "string" &&
    /^(?:ENOENT|EACCES|EPERM|EEXIST|EINVAL|ENOTDIR|ENOSPC|EROFS|ETIMEDOUT|ENOMEM|ENOBUFS|E2BIG|ERR_ASSERTION|ERR_CHILD_PROCESS_STDIO_MAXBUFFER)$/.test(
      value,
    )
    ? value
    : "unknown";
}
function safeSignal(value: unknown): string | null {
  return typeof value === "string" &&
    /^(?:SIGTERM|SIGKILL|SIGABRT|SIGSEGV|SIGILL|SIGBUS|SIGPIPE|SIGINT)$/.test(value)
    ? value
    : null;
}
class PythonCommandFailure extends Error {
  readonly code: number | string;
  readonly signal: string | null;
  readonly diagnostic: "python-shared-library-unavailable" | "command-failed";
  constructor(code: unknown, signal: unknown, stderr: string) {
    super("Pinned Python tool command failed");
    this.code = safeCode(code);
    this.signal = safeSignal(signal);
    // Classify one fixed loader message; never return raw stderr, argv or paths.
    this.diagnostic =
      this.code === 127 &&
      /error while loading shared libraries: libpython3\.15(?:t)?\.so(?:\.1\.0)?: cannot open shared object file/.test(
        stderr.slice(0, 4096),
      )
        ? "python-shared-library-unavailable"
        : "command-failed";
  }
}

export async function precommitLock(): Promise<PrecommitLock> {
  const lock = JSON.parse(
    await readFile(resolve(policyDirectory, "precommit-python.lock.json"), "utf8"),
  ) as PrecommitLock;
  const manifest = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
    fortipi: { toolchain: { python: string; preCommit: string } };
  };
  assert.equal(lock.format, 1);
  assert.equal(lock.python, manifest.fortipi.toolchain.python);
  assert.equal(
    lock.packages.find((p) => p.name === "pre-commit")?.version,
    manifest.fortipi.toolchain.preCommit,
  );
  assert.equal(lock.packages.find((p) => p.name === "pip")?.version, lock.pip);
  assert.equal(lock.hookSource.commit, "3e8a8703264a2f4a69428a0aa4dcb512790b2c8c");
  assert.equal(
    lock.packages.find((p) => p.name === "pre-commit-hooks")?.sha256,
    lock.hookSource.sha256,
  );
  assert.equal(new Set(lock.packages.map((p) => normalize(p.name))).size, lock.packages.length);
  assert.deepEqual(
    new Set([...lock.build, ...lock.runtime]),
    new Set(lock.packages.map((p) => p.name)),
  );
  for (const stage of ["build", "runtime"] as const) {
    const expected = `${lock[stage]
      .map((name) => {
        const entry = lock.packages.find((p) => p.name === name);
        assert.ok(entry);
        return `${name}==${entry.version} --hash=sha256:${entry.sha256}`;
      })
      .join("\n")}\n`;
    assert.equal(
      await readFile(resolve(policyDirectory, `precommit-${stage}.txt`), "utf8"),
      expected,
      "Python lock/requirements differ",
    );
  }
  for (const entry of [...lock.packages, ...lock.supportArchives]) {
    assert.match(entry.filename, /^[A-Za-z0-9_.-]+\.(whl|tar\.gz)$/);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= 16 * 1024 * 1024);
    const url = new URL(entry.url);
    assert.ok(
      url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
    );
    assert.ok(
      url.hostname === "files.pythonhosted.org" ||
        entry.url ===
          `https://codeload.github.com/pre-commit/pre-commit-hooks/tar.gz/${lock.hookSource.commit}`,
    );
  }
  for (const entry of lock.packages) {
    assert.ok(Object.keys(entry.licenses).length > 0, "Missing Python license inventory");
    for (const [path, hash] of Object.entries(entry.licenses)) {
      assert.ok(
        path.startsWith("tools/unstale/licenses/python/") && !path.split("/").includes(".."),
      );
      assert.equal(
        sha256(await readFile(resolve(repository, path))),
        hash,
        "Python license changed",
      );
    }
  }
  return lock;
}

/** Missing/changed local artifacts are fatal; never repair a supplied archive directory. */
export async function verifyPrecommitArchives(
  directory: string,
  suppliedLock?: PrecommitLock,
): Promise<void> {
  const lock = suppliedLock ?? (await precommitLock());
  assert.ok(safePath(directory));
  const expected = [...lock.packages, ...lock.supportArchives];
  assert.deepEqual(
    (await readdir(directory)).sort(),
    expected.map((p) => p.filename).sort(),
    "Python archive closure differs",
  );
  for (const entry of expected) {
    const path = resolve(directory, entry.filename);
    const stat = await lstat(path);
    assert.ok(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === entry.size,
      "Invalid Python archive",
    );
    assert.equal(sha256(await readFile(path)), entry.sha256, "Python archive hash changed");
  }
}

export async function downloadPrecommitArchives(
  directory: string,
  suppliedLock?: PrecommitLock,
): Promise<void> {
  const lock = suppliedLock ?? (await precommitLock());
  await mkdir(directory, { mode: 0o700 });
  await Promise.all(
    [...lock.packages, ...lock.supportArchives].map(async (entry) => {
      const response = await fetch(entry.url, {
        redirect: "error",
        signal: AbortSignal.timeout(120000),
      });
      assert.ok(response.ok && response.body, "Public Python archive unavailable");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        assert.ok(size <= entry.size, "Oversized Python archive");
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      assert.equal(size, entry.size, "Truncated Python archive");
      assert.equal(sha256(bytes), entry.sha256, "Python download hash changed");
      await writeFile(resolve(directory, entry.filename), bytes, { flag: "wx", mode: 0o400 });
    }),
  );
  await verifyPrecommitArchives(directory, lock);
}

function installEnvironment(directory: string): NodeJS.ProcessEnv {
  const system =
    process.platform === "win32"
      ? "C:\\Windows\\System32;C:\\Windows"
      : "/usr/bin:/bin:/usr/sbin:/sbin";
  return {
    PATH: `${resolve(directory, process.platform === "win32" ? "venv/Scripts" : "venv/bin")}${delimiter}${system}`,
    ...(process.platform === "win32" ? { SystemRoot: "C:\\Windows" } : {}),
    LANG: "C.UTF-8",
    PIP_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
    PYTHONDONTWRITEBYTECODE: "1",
    PIP_CACHE_DIR: resolve(directory, "cache"),
    TEMP: resolve(directory, "tmp"),
    TMP: resolve(directory, "tmp"),
    TMPDIR: resolve(directory, "tmp"),
  };
}
async function run(
  tool: string,
  args: string[],
  directory: string,
  timeout = 240000,
): Promise<string> {
  return new Promise((accept, reject) => {
    const child = execFile(
      tool,
      args,
      {
        env: installEnvironment(directory),
        cwd: directory,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) reject(new PythonCommandFailure(error.code, error.signal, stderr));
        else accept(stdout.trim());
      },
    );
    child.stdin?.end();
  });
}

async function interpreter(
  path: string,
  directory: string,
  lock: PrecommitLock,
  expected?: { path: string; sha256: string },
) {
  stage("interpreter-path");
  assert.ok(safePath(path), "Explicit Python executable required");
  stage("interpreter-realpath");
  const canonical = await realpath(path);
  stage("interpreter-stat");
  const stat = await lstat(canonical);
  stage("interpreter-file");
  assert.ok(stat.isFile(), "Untrusted Python executable");
  stage("interpreter-owner");
  assert.ok(own(stat.uid) || stat.uid === 0, "Untrusted Python executable");
  stage("interpreter-mode");
  assert.ok((stat.mode & 0o022) === 0, "Untrusted Python executable");
  stage("interpreter-sha256");
  const identity = { path: canonical, sha256: sha256(await readFile(canonical)) };
  stage("interpreter-expected");
  if (expected) assert.deepEqual(identity, expected, "Bootstrap Python changed");
  stage("interpreter-version-command");
  const version = await run(canonical, ["-I", "-S", "--version"], directory);
  stage("interpreter-version");
  assert.equal(version, `Python ${lock.python}`, "Pinned Python required");
  stage("interpreter-stable-sha256");
  assert.equal(
    sha256(await readFile(canonical)),
    identity.sha256,
    "Bootstrap Python changed during verification",
  );
  return identity;
}

const pythonIn = (directory: string) =>
  resolve(
    directory,
    process.platform === "win32" ? "venv/Scripts/python.exe" : "venv/bin/python3.15",
  );

async function installed(directory: string, lock: PrecommitLock): Promise<void> {
  stage("installed-metadata");
  const python = pythonIn(directory);
  // Stdlib introspection only. Closure, marker selection and validation stay in TypeScript.
  const facts = JSON.parse(
    await run(
      python,
      [
        "-I",
        "-B",
        "-c",
        "import sys,json,importlib.metadata as m; print(json.dumps(dict(prefix=sys.prefix,packages=sorted([[d.metadata['Name'],d.version] for d in m.distributions()]))))",
      ],
      directory,
    ),
  ) as { prefix: string; packages: string[][] };
  assert.equal(await realpath(facts.prefix), await realpath(resolve(directory, "venv")));
  assert.deepEqual(
    facts.packages
      .map(([name, version]) => {
        assert.ok(name && version);
        return [normalize(name), version];
      })
      .sort(),
    lock.packages.map((p) => [normalize(p.name), p.version]).sort(),
    "Installed Python closure differs",
  );
  stage("pip-check");
  assert.equal(
    await run(
      python,
      ["-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check", "check"],
      directory,
    ),
    "No broken requirements found.",
  );
  const lib =
    process.platform === "win32" ? "venv/Lib/site-packages" : "venv/lib/python3.15/site-packages";
  stage("hook-source");
  const modules: [string, string][] = [];
  const hookRoot = resolve(directory, lib, "pre_commit_hooks");
  for (const name of (await readdir(hookRoot)).sort()) {
    if (name === "__pycache__") continue;
    const path = resolve(hookRoot, name);
    assert.ok((await lstat(path)).isFile(), "Unexpected hook module");
    modules.push([`pre_commit_hooks/${name}`, sha256(await readFile(path))]);
  }
  modules.sort(([a], [b]) => a.localeCompare(b));
  assert.equal(modules.length, lock.hookSource.moduleCount);
  assert.equal(
    sha256(JSON.stringify(modules)),
    lock.hookSource.moduleTreeSha256,
    "Installed hook bytes differ from pinned source",
  );
  for (const command of commands) {
    const path = resolve(
      directory,
      process.platform === "win32" ? "venv/Scripts" : "venv/bin",
      `${command}${process.platform === "win32" ? ".exe" : ""}`,
    );
    const stat = await lstat(path);
    assert.ok(
      stat.isFile() && !stat.isSymbolicLink() && own(stat.uid),
      "Private hook executable missing",
    );
  }
}

async function treeHash(directory: string, freeze = false): Promise<string> {
  const records: [string, string | number][] = [];
  let bytes = 0;
  const visit = async (local: string): Promise<void> => {
    for (const name of (await readdir(resolve(directory, "venv", local))).sort()) {
      const child = local ? `${local}/${name}` : name;
      const path = resolve(directory, "venv", child);
      const stat = await lstat(path);
      assert.ok(own(stat.uid), "Tool environment owner changed");
      assert.ok(records.length < 30000, "Tool environment member bound");
      if (stat.isDirectory()) {
        await visit(child);
        if (freeze) await chmod(path, 0o500);
        records.push([child, process.platform === "win32" ? 0 : (await lstat(path)).mode]);
      } else if (stat.isSymbolicLink()) {
        records.push([child, await realpath(path)]);
      } else {
        assert.ok(stat.isFile() && stat.nlink === 1, "Tool environment member changed");
        bytes += stat.size;
        assert.ok(bytes <= 128 * 1024 * 1024, "Tool environment size bound");
        if (freeze) await chmod(path, stat.mode & 0o111 ? 0o500 : 0o400);
        records.push([
          child,
          `${process.platform === "win32" ? 0 : (await lstat(path)).mode}:${sha256(await readFile(path))}`,
        ]);
      }
    }
  };
  await visit("");
  return sha256(JSON.stringify(records));
}

export async function provisionPrecommit(
  pythonPath: string,
  directory: string,
  archives?: string,
): Promise<string> {
  stage("lock");
  const lock = await precommitLock();
  stage("directory");
  assert.ok(safePath(directory));
  stage("archives");
  if (archives) await verifyPrecommitArchives(archives, lock); // Before interpreter/package execution.
  stage("directory");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  for (const child of ["tmp", "cache", "pre-commit-home"])
    await mkdir(resolve(directory, child), { mode: 0o700 });
  const selected = await interpreter(pythonPath, directory, lock);
  const source = archives ?? resolve(directory, "archives");
  stage("download");
  if (!archives) await downloadPrecommitArchives(source, lock);
  stage("venv");
  await run(
    selected.path,
    ["-I", "-B", "-m", "venv", "--without-pip", resolve(directory, "venv")],
    directory,
  );
  const pip = lock.packages.find((p) => p.name === "pip");
  assert.ok(pip);
  for (const stage of ["build", "runtime"] as const) {
    if (import.meta.main) cliStage = "archives";
    await verifyPrecommitArchives(source, lock);
    const entry = stage === "build" ? [resolve(source, pip.filename, "pip")] : ["-m", "pip"];
    if (import.meta.main) cliStage = stage === "build" ? "install-build" : "install-runtime";
    await run(
      pythonIn(directory),
      [
        "-I",
        "-B",
        ...entry,
        "--isolated",
        "--disable-pip-version-check",
        "--no-cache-dir",
        "install",
        "--no-index",
        "--find-links",
        source,
        "--require-hashes",
        "--no-build-isolation",
        "--check-build-dependencies",
        "--no-compile",
        "-r",
        resolve(policyDirectory, `precommit-${stage}.txt`),
      ],
      directory,
    );
  }
  await installed(directory, lock);
  stage("freeze");
  await treeHash(directory, true);
  stage("identity");
  await writeFile(
    resolve(directory, "identity.json"),
    `${JSON.stringify({
      format: 1,
      lockSha256: sha256(JSON.stringify(lock)),
      python: selected,
      treeSha256: await treeHash(directory),
    })}\n`,
    { flag: "wx", mode: 0o400 },
  );
  return verifyPrecommit(directory, pythonPath);
}

export async function verifyPrecommit(directory: string, pythonPath: string): Promise<string> {
  stage("verify");
  const lock = await precommitLock();
  assert.ok(
    safePath(directory) && (await realpath(directory)) === directory,
    "Private tool root changed",
  );
  const stat = await lstat(directory);
  assert.ok(
    stat.isDirectory() &&
      own(stat.uid) &&
      (process.platform === "win32" || (stat.mode & 0o777) === 0o700),
    "Private tool root changed",
  );
  const identity = JSON.parse(await readFile(resolve(directory, "identity.json"), "utf8")) as {
    format: number;
    lockSha256: string;
    python: { path: string; sha256: string };
    treeSha256: string;
  };
  assert.equal(identity.format, 1);
  assert.equal(
    identity.lockSha256,
    sha256(JSON.stringify(lock)),
    "Python lock changed; rebuild private environment",
  );
  assert.deepEqual(
    await interpreter(pythonPath, directory, lock, identity.python),
    identity.python,
    "Bootstrap Python changed",
  );
  stage("verify");
  assert.equal(await treeHash(directory), identity.treeSha256, "Private tool environment changed");
  await installed(directory, lock);
  return resolve(directory, process.platform === "win32" ? "venv/Scripts" : "venv/bin");
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const options = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index],
        value = args[index + 1];
      assert.ok(
        key &&
          ["--python", "--directory", "--archives", "--verify", "--github-path"].includes(key) &&
          value &&
          !options.has(key),
        "Invalid pre-commit bootstrap arguments",
      );
      options.set(key, value);
    }
    const python = options.get("--python"),
      directory = options.get("--verify") ?? options.get("--directory");
    assert.ok(python && directory && !(options.has("--verify") && options.has("--directory")));
    const bin = options.has("--verify")
      ? await verifyPrecommit(directory, python)
      : await provisionPrecommit(python, directory, options.get("--archives"));
    const exportFile = options.get("--github-path");
    if (exportFile) {
      stage("github-path");
      assert.ok(safePath(exportFile));
      const file = await open(
        exportFile,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        assert.ok(stat.isFile() && own(stat.uid) && stat.nlink === 1);
        await file.writeFile(`${bin}\n`);
      } finally {
        await file.close();
      }
    }
    console.log(
      JSON.stringify({
        python: (await precommitLock()).python,
        bin,
        preCommitHome: resolve(directory, "pre-commit-home"),
      }),
    );
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown } | null;
    console.error(
      "Pinned pre-commit environment unavailable or changed; bootstrap/verify refused",
      JSON.stringify({
        stage: cliStage,
        code: safeCode(failure?.code),
        signal: safeSignal(failure?.signal),
        diagnostic:
          error instanceof PythonCommandFailure
            ? error.diagnostic
            : error instanceof assert.AssertionError
              ? "invariant"
              : "unavailable",
      }),
    );
    process.exitCode = 1;
  }
}
