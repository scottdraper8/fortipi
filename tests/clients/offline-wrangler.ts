import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

/** Explicitly nonsecret and unusable as Cloudflare authentication. Only local
 * Wrangler fixtures receive these; ordinary application clients never do. */
export function offlineWranglerEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    XDG_CONFIG_HOME: resolve(directory, "config"),
    XDG_CACHE_HOME: resolve(directory, "cache"),
    CLOUDFLARE_API_TOKEN: "fortipi-offline-synthetic-not-a-cloudflare-token",
    CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
    CLOUDFLARE_AUTH_USE_KEYRING: "false",
    CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:1/client/v4",
    CLOUDFLARE_BASE_URL: "http://127.0.0.1:1/client/v4",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_HIDE_BANNER: "true",
    WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"),
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    DO_NOT_TRACK: "1",
    CI: "true",
  };
}
/** Normal pinned auth-command path with no network/child permission and fs
 * access only to public dependency bytes and this private temporary directory.
 * Node's permission model is a trusted-code guard, not an OS sandbox. */
export async function verifyOfflineWranglerAuth(bin: string) {
  const actual = await realpath(bin);
  const root = dirname(dirname(actual));
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  assert.equal(manifest.name, "wrangler");
  const cli = resolve(root, "wrangler-dist/cli.js");
  let dependencies: string | undefined;
  for (let path = root; path !== dirname(path); path = dirname(path))
    if (basename(path) === "node_modules") dependencies = path;
  assert.ok(dependencies);
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-offline-auth-")));
  try {
    const env = offlineWranglerEnvironment(directory);
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${dependencies}`,
        `--allow-fs-read=${directory}`,
        `--allow-fs-write=${directory}`,
        cli,
        "auth",
        "token",
        "--json",
      ],
      { cwd: directory, env, timeout: 30000, maxBuffer: 1048576, windowsHide: true },
    );
    const value: unknown = JSON.parse(result.stdout.trim());
    assert.deepEqual(value, { type: "api_token", token: env.CLOUDFLARE_API_TOKEN });
    return {
      version: manifest.version,
      actualPinnedAuthCommand: true,
      explicitSyntheticIdentity: true,
      networkPermission: false,
      childProcessPermission: false,
      actualUserAuthFileReadPermission: false,
      limitation:
        "Auth-env precedence only; no complete runtime/OS isolation or actual Cloudflare authentication proof",
    };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const code = stderr.match(/\bERR_[A-Z_]+\b/)?.[0] ?? "unclassified";
    throw new Error(
      `Pinned offline Wrangler auth precedence could not be verified without user-file/network/child access (${code})`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
