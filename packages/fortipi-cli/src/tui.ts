import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { CliError, check } from "./errors.js";
import { helperEnvironment } from "./profiles.js";

export function tuiEnvironment(): NodeJS.ProcessEnv {
  const env = helperEnvironment();
  for (const key of [
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "XDG_CONFIG_HOME",
    "COLORTERM",
    "NO_COLOR",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}
async function tuiExecutable(): Promise<{ command: string; args: string[] }> {
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(
      directory,
      process.platform === "win32" ? "fortipi-tui.cmd" : "fortipi-tui",
    );
    try {
      const path = await realpath(candidate);
      check((await stat(path)).isFile(), "invalid_tui_executable", 3);
      if (process.platform !== "win32") {
        await access(path, constants.X_OK);
        return { command: path, args: [] };
      }
      const shim = await readFile(path, "utf8");
      const targets = [...shim.matchAll(/"%~dp0%[\\/]([^"\r\n]+\.js)"/g)].map(
        (m) => m[1] as string,
      );
      check(targets.length > 0 && new Set(targets).size === 1, "unsupported_tui_shim", 3);
      const target = resolve(dirname(path), targets[0] as string);
      check((await stat(target)).isFile(), "invalid_tui_executable", 3);
      return { command: process.execPath, args: [target] };
    } catch (e) {
      if (e instanceof CliError) throw e;
    }
  }
  throw new CliError("install_separate_fortipi_tui_package", 3);
}
export async function launchTui(
  args: string[],
  signal: AbortSignal,
): Promise<{ exitCode: number }> {
  const executable = await tuiExecutable();
  const exitCode = await new Promise<number>((accept, reject) => {
    const child = spawn(executable.command, [...executable.args, ...args], {
      shell: false,
      stdio: "inherit",
      env: tuiEnvironment(),
    });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", () => {
      signal.removeEventListener("abort", abort);
      reject(new CliError("tui_spawn_failed", 3));
    });
    child.once("exit", (code) => {
      signal.removeEventListener("abort", abort);
      accept(signal.aborted ? 130 : (code ?? 1));
    });
  });
  return { exitCode };
}
