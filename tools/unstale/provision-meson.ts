// Build-host tool only. Execute original upstream files after authenticating the archive.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, posix, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import {
  copyPrivatePython,
  type PrivatePython,
  removePrivatePython,
  verifyPrivatePython,
} from "./private-python.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const policy = JSON.parse(
  await readFile(resolve(repository, "tools/unstale/platform-tools.json"), "utf8"),
) as {
  externalRuntimes: { python: { version: string } };
  meson: {
    version: string;
    source: string;
    url: string;
    sourceArchiveSha256: string;
    entrypointSha256: string;
    licensePath: string;
    licenseSha256: string;
  };
};
export const mesonPin = policy.meson;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const exec = promisify(execFile);
const limit = 32 * 1024 * 1024;
const hasControl = (value: string) =>
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const safePath = (path: string) =>
  isAbsolute(path) && !hasControl(path) && !path.includes(delimiter);

const toolKinds = ["shared-library", "missing", "permission", "killed", "nonzero"] as const;
type ToolOperation = "python" | "meson";
class MesonToolError extends Error {
  readonly kind: (typeof toolKinds)[number];
  readonly operation: ToolOperation;
  constructor(operation: ToolOperation, error: unknown) {
    super("Meson provisioner: tool failed or timed out");
    const e = error as { code?: unknown; killed?: unknown; stderr?: unknown } | null;
    this.kind =
      typeof e?.stderr === "string" && e.stderr.includes("error while loading shared libraries:")
        ? "shared-library"
        : e?.code === "ENOENT"
          ? "missing"
          : e?.code === "EACCES"
            ? "permission"
            : e?.killed === true
              ? "killed"
              : "nonzero";
    this.operation = operation;
  }
}
const reasons = [
  ["Private Python", "private-python-identity"],
  ["Unsupported bootstrap Python", "private-python-layout"],
  ["Unowned bootstrap Python", "private-python-owner"],
  ["Bootstrap Python links", "private-python-link"],
  ["Bootstrap Python changed", "private-python-source-changed"],
  ["Python member bound", "private-python-bound"],
  ["Python byte bound", "private-python-bound"],
  ["Unsafe Python executable", "python-permissions"],
  ["Pinned Python required", "python-version"],
  ["Python identity changed", "python-identity"],
  ["Meson archive identity changed", "archive-identity"],
  ["Meson source changed", "source-identity"],
  ["Meson private filesystem identity changed", "private-identity"],
  ["Unsafe GITHUB_PATH file", "path-export"],
  ["Explicit absolute Python path required", "python-path"],
] as const;
export function mesonFailure(error: unknown) {
  return {
    probe: "meson-provisioning",
    passed: false,
    reason:
      error instanceof MesonToolError
        ? "tool"
        : error instanceof Error
          ? (reasons.find(([message]) => error.message.startsWith(message))?.[1] ?? "unknown")
          : "unknown",
    ...(error instanceof MesonToolError
      ? {
          operation: ["python", "meson"].find((value) => value === error.operation) ?? "unknown",
          kind: toolKinds.find((value) => value === error.kind) ?? "nonzero",
        }
      : {}),
  };
}
async function command(
  file: string,
  args: string[],
  path: string,
  operation: ToolOperation,
  runtime?: PrivatePython,
  maxBuffer = 4096,
): Promise<string> {
  try {
    return (
      await exec(file, args, {
        cwd: repository,
        env: {
          PATH: path,
          LANG: "C",
          LC_ALL: "C",
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONNOUSERSITE: "1",
          ...(runtime ? { LD_LIBRARY_PATH: resolve(runtime.root, "lib") } : {}),
        },
        timeout: 15_000,
        killSignal: "SIGKILL",
        maxBuffer,
      })
    ).stdout.trim();
  } catch (error) {
    throw new MesonToolError(operation, error);
  }
}

/** No filesystem writes or archive code execution, including on authentication failure. */
export async function mesonFiles(raw: Buffer, pin = mesonPin): Promise<Map<string, Buffer>> {
  assert.ok(raw.length <= limit, "Meson archive exceeds limit");
  assert.equal(digest(raw), pin.sourceArchiveSha256, "Meson archive identity changed");
  const tar = gunzipSync(raw, { maxOutputLength: 128 * 1024 * 1024 });
  const prefix = `meson-${pin.source}`;
  const seen = new Set<string>();
  const files = new Map<string, Buffer>();
  await new Promise<void>((accept, reject) => {
    const parser = new Parser({ strict: true });
    parser.on("error", () => reject(new Error("Invalid Meson archive")));
    parser.on("warn", () => reject(new Error("Invalid Meson archive")));
    parser.on("ignoredEntry", () => reject(new Error("Unsupported Meson archive member")));
    parser.on("end", accept);
    parser.on("entry", (entry) => {
      try {
        const name = entry.path.replace(/\/$/, "");
        assert.ok(!name.includes("\\") && !hasControl(name), "Unsafe Meson archive path");
        assert.ok(
          name.split("/").every((part: string) => part && part !== "." && part !== ".."),
          "Unsafe Meson archive path",
        );
        assert.ok(
          name === prefix || name.startsWith(`${prefix}/`),
          "Unexpected Meson archive root",
        );
        assert.ok(!seen.has(name), "Duplicate Meson archive member");
        seen.add(name);
        const local = name.slice(prefix.length + 1);
        const selected =
          ["meson.py", "COPYING", "mesonbuild"].includes(local) || local.startsWith("mesonbuild/");
        if (entry.type === "SymbolicLink" && !selected) {
          const target = entry.linkpath ?? "";
          assert.ok(
            target && !target.startsWith("/") && !target.includes("\\") && !hasControl(target),
            "Unsafe Meson archive link",
          );
          assert.ok(
            posix.join(posix.dirname(name), target).startsWith(`${prefix}/`),
            "Escaping Meson archive link",
          );
        } else {
          assert.ok(["File", "Directory"].includes(entry.type), "Unsupported Meson archive member");
          assert.ok(
            !entry.linkpath && ((entry.mode ?? 0) & 0o7000) === 0,
            "Unsafe Meson archive member",
          );
        }
        assert.ok(
          entry.size <= limit && (entry.type !== "Directory" || entry.size === 0),
          "Oversized Meson member",
        );
        if (selected && entry.type === "File") {
          const chunks: Buffer[] = [];
          entry.on("data", (chunk: Buffer) => chunks.push(chunk));
          entry.on("end", () => files.set(local, Buffer.concat(chunks)));
        }
      } catch {
        reject(new Error("Unsafe Meson archive member"));
      }
      entry.resume();
    });
    parser.end(tar);
  });
  assert.equal(
    digest(files.get("COPYING") ?? Buffer.alloc(0)),
    pin.licenseSha256,
    "Meson license changed",
  );
  assert.equal(
    digest(files.get("meson.py") ?? Buffer.alloc(0)),
    pin.entrypointSha256,
    "Meson entrypoint changed",
  );
  assert.ok(
    files.has("mesonbuild/__init__.py") && files.has("mesonbuild/mesonmain.py"),
    "Missing Meson package",
  );
  return files;
}

interface PythonIdentity {
  path: string;
  sha256: string;
  version: string;
  runtime?: PrivatePython;
}

/** Compare saved identity before executing Python; never search PATH for an alternative. */
export async function pythonIdentity(
  path: string,
  expected?: PythonIdentity,
  runtime = expected?.runtime,
): Promise<PythonIdentity> {
  if (runtime) {
    assert.match(runtime.treeSha256, /^[a-f0-9]{64}$/, "Private Python tree identity required");
    await verifyPrivatePython(runtime);
    assert.equal(path, resolve(runtime.root, "bin/python3.15"), "Private Python path changed");
  }
  assert.ok(safePath(path), "Explicit absolute Python path required");
  const canonical = await realpath(path);
  assert.ok(safePath(canonical), "Unsafe canonical Python path");
  const stat = await lstat(canonical);
  try {
    assert.ok(
      stat.isFile() &&
        (stat.uid === 0 || stat.uid === process.getuid?.()) &&
        (stat.mode & 0o111) !== 0 &&
        (stat.mode & 0o022) === 0,
      "Unsafe Python executable",
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        probe: "meson-python-input",
        regular: stat.isFile(),
        owner: stat.uid === 0 ? "root" : stat.uid === process.getuid?.() ? "caller" : "other",
        executable: (stat.mode & 0o111) !== 0,
        groupWritable: (stat.mode & 0o020) !== 0,
        otherWritable: (stat.mode & 0o002) !== 0,
      }),
    );
    throw error;
  }
  const identity = {
    path: canonical,
    sha256: digest(await readFile(canonical)),
    version: policy.externalRuntimes.python.version,
    ...(runtime ? { runtime } : {}),
  };
  if (expected) assert.deepEqual(identity, expected, "Python identity changed");
  assert.equal(
    await command(canonical, ["-I", "-S", "--version"], "/usr/bin:/bin", "python", runtime),
    `Python ${identity.version}`,
    "Pinned Python required",
  );
  if (runtime) {
    // Native CPython introspection only; the maintained verifier is TypeScript.
    const expression =
      "import sys,os,json,sysconfig,subprocess,hashlib,encodings; print(json.dumps(dict(executable=os.path.realpath(sys.executable),prefixes=[sys.prefix,sys.exec_prefix,sys.base_prefix,sys.base_exec_prefix],paths=sys.path,origins=[os.path.realpath(m.__file__) for m in list(sys.modules.values()) if getattr(m,'__file__',None)],libraries=sorted(set(line.split(None,5)[5].strip() for line in open('/proc/self/maps') if 'libpython3.15' in line)))))";
    const facts: unknown = JSON.parse(
      await command(
        canonical,
        ["-I", "-S", "-B", "-c", expression],
        "/usr/bin:/bin",
        "python",
        runtime,
        128 * 1024,
      ),
    );
    assert.ok(
      facts && typeof facts === "object" && !Array.isArray(facts),
      "Private Python runtime identity changed",
    );
    const value = facts as Record<string, unknown>;
    assert.equal(value.executable, canonical, "Private Python executable changed");
    assert.deepEqual(
      value.prefixes,
      Array(4).fill(runtime.root),
      "Private Python prefixes changed",
    );
    for (const key of ["paths", "origins"] as const) {
      const entries = value[key];
      assert.ok(
        Array.isArray(entries) && entries.length > 0 && entries.length <= 512,
        "Private Python imports changed",
      );
      for (const path of entries)
        assert.ok(
          typeof path === "string" && path.startsWith(`${runtime.root}/`),
          "Private Python imports escaped",
        );
    }
    assert.deepEqual(
      value.libraries,
      [resolve(runtime.root, "lib/libpython3.15.so.1.0")],
      "Private Python mapped library changed",
    );
    console.log(
      JSON.stringify({
        probe: "private-python-runtime",
        passed: true,
        prefixesPrivate: true,
        importsPrivate: true,
        mappedLibraryPrivate: true,
      }),
    );
  }
  assert.equal(
    digest(await readFile(canonical)),
    identity.sha256,
    "Python changed during verification",
  );
  return identity;
}

async function owned(path: string, mode: number, directory = false): Promise<void> {
  const stat = await lstat(path);
  assert.ok(
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o7777) === mode,
    "Meson private filesystem identity changed",
  );
}

/** Recheck the closed source tree and both launch links before invoking upstream code. */
export async function verifyMesonTree(
  directory: string,
  files: Map<string, Buffer>,
  python: string,
): Promise<void> {
  assert.ok(
    safePath(directory) && (await realpath(directory)) === directory,
    "Meson root must be canonical",
  );
  await owned(directory, 0o700, true);
  await owned(resolve(directory, "bin"), 0o500, true);
  const links = { meson: "../source/meson.py", python3: python };
  assert.deepEqual(
    (await readdir(resolve(directory, "bin"))).sort(),
    Object.keys(links).sort(),
    "Meson bin changed",
  );
  for (const [name, target] of Object.entries(links)) {
    const path = resolve(directory, "bin", name);
    const stat = await lstat(path);
    assert.ok(
      stat.isSymbolicLink() && stat.uid === process.getuid?.(),
      "Meson launch link changed",
    );
    assert.equal(await readlink(path), target, "Meson launch target changed");
  }
  const expectedDirectories = new Set<string>();
  for (const name of files.keys()) {
    for (let parent = dirname(name); parent !== "."; parent = dirname(parent))
      expectedDirectories.add(parent);
  }
  const seen = new Set<string>();
  const walk = async (local: string): Promise<void> => {
    const path = resolve(directory, "source", local);
    await owned(path, 0o500, true);
    for (const name of await readdir(path)) {
      const child = local ? `${local}/${name}` : name;
      if (expectedDirectories.has(child)) await walk(child);
      else {
        const expected = files.get(child);
        assert.ok(expected, "Unexpected Meson source member");
        const target = resolve(directory, "source", child);
        await owned(target, child === "meson.py" ? 0o500 : 0o400);
        assert.equal(digest(await readFile(target)), digest(expected), "Meson source changed");
        seen.add(child);
      }
    }
  };
  await walk("");
  assert.equal(seen.size, files.size, "Missing Meson source member");
}

function record(python: PythonIdentity) {
  return {
    schema: 1,
    source: mesonPin.source,
    sourceArchiveSha256: mesonPin.sourceArchiveSha256,
    entrypointSha256: mesonPin.entrypointSha256,
    python,
  };
}

export async function verifyMeson(
  directory: string,
  pythonPath: string,
): Promise<{ pythonLibraryPath?: string }> {
  assert.ok(
    safePath(directory) && (await realpath(directory)) === directory,
    "Meson root must be canonical",
  );
  await owned(directory, 0o700, true);
  for (const name of ["source.tgz", "identity.json"]) await owned(resolve(directory, name), 0o400);
  assert.ok(
    (await lstat(resolve(directory, "source.tgz"))).size <= limit,
    "Meson archive exceeds limit",
  );
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ["bin", "identity.json", "source", "source.tgz"],
    "Meson root changed",
  );
  assert.ok(
    (await lstat(resolve(directory, "identity.json"))).size <= 4096,
    "Meson identity exceeds limit",
  );
  const saved = JSON.parse(
    await readFile(resolve(directory, "identity.json"), "utf8"),
  ) as ReturnType<typeof record>;
  assert.ok(saved.python && typeof saved.python.sha256 === "string", "Missing Python identity");
  const files = await mesonFiles(await readFile(resolve(directory, "source.tgz")));
  const python = await pythonIdentity(pythonPath, saved.python);
  assert.deepEqual(saved, record(python), "Meson identity record changed");
  await verifyMesonTree(directory, files, python.path);
  assert.equal(
    await command(
      resolve(directory, "bin/meson"),
      ["--version"],
      `${directory}/bin:/usr/bin:/bin`,
      "meson",
      python.runtime,
    ),
    mesonPin.version,
    "Meson version changed",
  );
  return python.runtime ? { pythonLibraryPath: resolve(python.runtime.root, "lib") } : {};
}

async function download(): Promise<Buffer> {
  assert.equal(
    mesonPin.url,
    `https://codeload.github.com/mesonbuild/meson/tar.gz/${mesonPin.source}`,
  );
  const response = await fetch(mesonPin.url, {
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  assert.ok(response.ok && response.body, "Meson public download failed");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) {
      throw new Error("Meson download exceeds limit");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function provisionMeson(
  pythonPath: string,
  raw: Buffer,
  isolatePython = false,
): Promise<string> {
  assert.match(mesonPin.source, /^[a-f0-9]{40}$/);
  const files = await mesonFiles(raw);
  assert.equal(
    digest(await readFile(resolve(repository, mesonPin.licensePath))),
    mesonPin.licenseSha256,
    "Vendored Meson license changed",
  );
  const parent = resolve(repository, "dist/toolchain");
  await mkdir(parent, { recursive: true });
  assert.ok(!isolatePython || process.platform === "linux", "Private bootstrap requires Linux");
  const runtime = isolatePython ? await copyPrivatePython(pythonPath, parent) : undefined;
  const selectedPython = runtime ? resolve(runtime.root, "bin/python3.15") : pythonPath;
  let directory: string | undefined;
  const directories = new Set<string>();
  try {
    directory = await mkdtemp(resolve(await realpath(parent), "meson-"));
    await chmod(directory, 0o700);
    const python = await pythonIdentity(selectedPython, undefined, runtime);
    const source = resolve(directory, "source");
    await mkdir(source, { mode: 0o700 });
    directories.add(source);
    for (const [name, bytes] of files) {
      const target = resolve(source, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      for (let parent = dirname(target); parent.startsWith(source); parent = dirname(parent))
        directories.add(parent);
      await writeFile(target, bytes, { flag: "wx", mode: name === "meson.py" ? 0o500 : 0o400 });
    }
    for (const path of directories) await chmod(path, 0o500);
    const bin = resolve(directory, "bin");
    await mkdir(bin, { mode: 0o700 });
    directories.add(bin);
    await symlink("../source/meson.py", resolve(bin, "meson"));
    await symlink(python.path, resolve(bin, "python3"));
    await chmod(bin, 0o500);
    await writeFile(resolve(directory, "source.tgz"), raw, { flag: "wx", mode: 0o400 });
    await writeFile(resolve(directory, "identity.json"), `${JSON.stringify(record(python))}\n`, {
      flag: "wx",
      mode: 0o400,
    });
    await verifyMeson(directory, selectedPython);
    return directory;
  } catch (error) {
    // Read-only source directories intentionally prevent Python bytecode additions.
    for (const path of directories) await chmod(path, 0o700).catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (runtime) await removePrivatePython(runtime.root).catch(() => {});
    throw error;
  }
}

async function exportPath(directory: string): Promise<void> {
  if (process.env.CI !== "true") return;
  const path = process.env.GITHUB_PATH;
  assert.ok(path && safePath(path), "CI requires the existing GITHUB_PATH file");
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert.ok(
      stat.isFile() && stat.uid === process.getuid?.() && stat.nlink === 1,
      "Unsafe GITHUB_PATH file",
    );
    await file.writeFile(`${directory}/bin\n`);
  } finally {
    await file.close();
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const isolated = args.at(-1) === "--private-python";
    if (isolated) args.pop();
    assert.ok(args.length === 2 || args.length === 4, "Invalid arguments");
    assert.equal(args[0], "--python");
    const python = args[1];
    assert.ok(python && safePath(python), "Explicit absolute Python path required");
    let directory: string;
    if (args[2] === "--verify") {
      assert.ok(args[3] && safePath(args[3]));
      directory = args[3];
      await verifyMeson(directory, python);
    } else {
      assert.ok(args.length === 2 || args[2] === "--archive");
      if (args[3]) assert.ok(safePath(args[3]));
      directory = await provisionMeson(
        python,
        args[3] ? await readFile(args[3]) : await download(),
        isolated,
      );
    }
    await exportPath(directory);
    console.log(JSON.stringify({ version: mesonPin.version, directory, bin: `${directory}/bin` }));
  } catch (error) {
    console.error(JSON.stringify(mesonFailure(error)));
    console.error(
      "Meson provisioning/verification failed; require pinned archive, Python and private tool identity",
    );
    process.exitCode = 1;
  }
}
