// Builtin-only so dependency installation can use this locator before node_modules exists.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, resolve } from "node:path";
import { promisify } from "node:util";

function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "MODULE_NOT_FOUND"].includes(String(error.code))
  );
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export async function pnpmExecutable(
  platform: NodeJS.Platform = process.platform,
  searchPath = (process.env.PATH ?? process.env.Path ?? "").split(delimiter),
): Promise<string> {
  if (platform !== "win32") return "pnpm";
  for (const directory of searchPath.filter(Boolean)) {
    const direct = resolve(directory, "pnpm.exe");
    if (await regularFile(direct)) return direct;
    if (
      !(await regularFile(resolve(directory, "pnpm.cmd"))) &&
      !(await regularFile(resolve(directory, "pnpm")))
    )
      continue;
    try {
      const lookup = createRequire(resolve(directory, ".fortipi-pnpm-lookup.cjs"));
      const manifestPath = lookup.resolve("pnpm/package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        name: string;
        version: string;
      };
      if (manifest.name !== "pnpm" || manifest.version !== "12.18.0")
        throw new Error("Use the reviewed pnpm 12.18.0 native installation");
      // pnpm's official Windows installer creates this executable beside its package manifest.
      const native = resolve(dirname(manifestPath), "pnpm.exe");
      if (await regularFile(native)) return native;
      // Its reviewed optional package also works when manager install scripts were disabled.
      const packageName = `@pnpm/exe.win32-${process.arch}`;
      const packageLookup = createRequire(manifestPath);
      const nativeManifest = JSON.parse(
        await readFile(packageLookup.resolve(`${packageName}/package.json`), "utf8"),
      ) as { name: string; version: string };
      if (nativeManifest.name !== packageName || nativeManifest.version !== "12.18.0")
        throw new Error("Use the reviewed pnpm 12.18.0 native installation");
      const optional = packageLookup.resolve(`${packageName}/pnpm.exe`);
      if (await regularFile(optional)) return optional;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  throw new Error("Cannot locate pnpm.exe; install pnpm 12.18.0 with its native build enabled");
}

export async function verifyPnpmExecutable(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<string> {
  const version = await promisify(execFile)(executable, ["--version"], {
    cwd,
    env,
    timeout: 30_000,
    maxBuffer: 4096,
  });
  if (version.stdout.trim() !== "12.18.0")
    throw new Error("Use the reviewed pnpm 12.18.0 native installation");
  return "12.18.0";
}
