import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, check } from "./errors.js";
import { helperEnvironment } from "./profiles.js";

export interface WranglerRequest {
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  input?: string;
  inheritInput?: boolean;
  terminal?: boolean;
  deploymentAuth?: boolean;
  outputFile?: string;
}
export interface WranglerPort {
  run(request: WranglerRequest): Promise<string>;
}
export async function wranglerBin(): Promise<string> {
  check(process.versions.node === "26.13.1", "verified_node_26_13_required", 3);
  const path = createRequire(import.meta.url).resolve("wrangler/package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as {
    version: string;
    bin: Record<string, string>;
  };
  check(
    manifest.version === "4.162.0" && typeof manifest.bin.wrangler === "string",
    "pinned_wrangler_required",
    3,
  );
  const bin = resolve(dirname(path), manifest.bin.wrangler);
  check(
    bin.startsWith(`${dirname(path)}/`) || bin.startsWith(`${dirname(path)}\\`),
    "invalid_wrangler_bin",
    3,
  );
  return bin;
}
export function wranglerEnvironment(request: WranglerRequest): NodeJS.ProcessEnv {
  const env = helperEnvironment();
  // This filters inherited credentials, not filesystem access: Wrangler checks the OS home for legacy config.
  // Wrangler owns supported CF login storage. Provider and application credentials are excluded.
  if (request.deploymentAuth)
    for (const key of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "XDG_CONFIG_HOME",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
    ])
      if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_LOG_LEVEL: "error",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  });
  if (request.outputFile) env.WRANGLER_OUTPUT_FILE_PATH = request.outputFile;
  return env;
}
export const wrangler: WranglerPort = {
  async run(request) {
    check(
      isAbsolute(request.cwd) && (!request.outputFile || isAbsolute(request.outputFile)),
      "explicit_wrangler_paths_required",
    );
    check(!(request.input !== undefined && request.terminal), "invalid_secret_input_mode");
    const bin = await wranglerBin();
    const signal = AbortSignal.any([
      AbortSignal.timeout(request.timeoutMs ?? 120000),
      ...(request.signal ? [request.signal] : []),
    ]);
    try {
      return await new Promise<string>((accept, reject) => {
        const child = spawn(process.execPath, [bin, ...request.args], {
          cwd: request.cwd,
          shell: false,
          windowsHide: true,
          env: wranglerEnvironment(request),
          stdio: request.terminal
            ? ["inherit", process.stderr, process.stderr]
            : [request.inheritInput ? "inherit" : "pipe", "pipe", "pipe"],
        });
        let output = "";
        let total = 0;
        let oversized = false;
        let inputFailed = false;
        const abort = () => {
          child.kill("SIGKILL");
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.stdout?.on("data", (data: Buffer) => {
          total += data.length;
          if (total > 1048576) {
            oversized = true;
            abort();
          } else output += data.toString("utf8");
        });
        child.stderr?.on("data", (data: Buffer) => {
          // Captured diagnostic bytes are discarded; even secret-put errors may contain input.
          total += data.length;
          if (total > 1048576) {
            oversized = true;
            abort();
          }
        });
        child.stdin?.on("error", () => {
          inputFailed = true;
          abort();
        });
        child.once("error", () => {
          signal.removeEventListener("abort", abort);
          reject(new CliError("wrangler_spawn_failed", 3));
        });
        child.once("close", (code) => {
          signal.removeEventListener("abort", abort);
          if (code === 0 && !signal.aborted && !oversized && !inputFailed) accept(output);
          else
            reject(
              new CliError(
                signal.aborted ? "wrangler_cancelled_or_timed_out" : "wrangler_failed_or_uncertain",
              ),
            );
          output = "";
        });
        child.stdin?.end(request.input);
      });
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError("wrangler_failed_or_uncertain");
    }
  },
};
export async function secretPut(
  port: WranglerPort,
  directory: string,
  name: string,
  options: { input?: string; signal?: AbortSignal; nonInteractive?: boolean } = {},
): Promise<void> {
  check(/^[A-Z][A-Z0-9_]{0,127}$/.test(name), "invalid_secret_name");
  check(
    options.input !== undefined ||
      (!options.nonInteractive &&
        process.stdin.isTTY &&
        process.stdout.isTTY &&
        process.stderr.isTTY),
    "wrangler_secret_prompt_requires_terminal",
    3,
  );
  await port.run({
    args: ["secret", "put", name, "--config", resolve(directory, "wrangler.json")],
    cwd: directory,
    deploymentAuth: true,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.input === undefined ? { terminal: true } : { input: options.input }),
  });
}
export async function secretNames(
  port: WranglerPort,
  directory: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const output = await port.run({
    args: ["secret", "list", "--format", "json", "--config", resolve(directory, "wrangler.json")],
    cwd: directory,
    deploymentAuth: true,
    ...(signal ? { signal } : {}),
  });
  let list: unknown;
  try {
    list = JSON.parse(output);
  } catch {
    throw new CliError("invalid_secret_name_list");
  }
  check(
    Array.isArray(list) &&
      list.length <= 1024 &&
      list.every(
        (item) =>
          item && typeof item.name === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(item.name),
      ),
    "invalid_secret_name_list",
    1,
  );
  return list.map((item: { name: string }) => item.name);
}
export const cliPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
