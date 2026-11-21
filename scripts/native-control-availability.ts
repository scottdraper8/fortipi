// Read-only native tool prerequisites; no caller-supplied targets or sampler attach.
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";

type State =
  | "not-checked"
  | "absent"
  | "untrusted"
  | "unusable"
  | "timeout"
  | "output-limit"
  | "cleanup-unconfirmed"
  | "present";
type Fact = { state: State; closed: boolean };
type Tool = "perf" | "gdb" | "ss";
const specs = {
  perf: { path: "/usr/bin/perf", args: ["--version"], version: /^perf version [0-9]/m },
  gdb: {
    path: "/usr/bin/gdb",
    args: ["--nx", "--batch", "--quiet", "-iex", "set auto-load off", "--version"],
    version: /^GNU gdb\b/m,
  },
  ss: { path: "/usr/bin/ss", args: ["--version"], version: /^ss utility, iproute2-/m },
} as const;

async function check(tool: Tool): Promise<Fact> {
  const spec = specs[tool];
  try {
    const path = await realpath(spec.path),
      metadata = await stat(path);
    // Do not execute a substituted user-writable tool or a helper from a home/cache path.
    if (
      !path.startsWith("/usr/") ||
      !metadata.isFile() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0 ||
      (metadata.mode & 0o111) === 0
    )
      return { state: "untrusted", closed: true };
  } catch (error) {
    return {
      state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unusable",
      closed: true,
    };
  }
  return new Promise((accept) => {
    // No inherited environment, user perf config, GDB init, target, script, shell or network.
    const child = spawn(spec.path, [...spec.args], {
      cwd: "/",
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        PERF_CONFIG: "/dev/null",
        DEBUGINFOD_URLS: "",
      },
    });
    let settled = false,
      stopping = false,
      bytes = 0;
    let reason: State | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const finish = (state: State, closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeTimer) clearTimeout(closeTimer);
      chunks.length = 0;
      accept({ state, closed });
    };
    const stop = (state: State) => {
      if (settled || stopping) return;
      stopping = true;
      reason = state;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Closed/spawn-failed group. */
        }
      }
      child.kill("SIGKILL");
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        // Never turn uncertain process cleanup into an availability success.
        finish("cleanup-unconfirmed", false);
      }, 250);
    };
    const timer = setTimeout(() => stop("timeout"), 1000);
    const retain = (data: Buffer) => {
      if (settled) return;
      bytes += data.length;
      if (bytes > 8192) stop("output-limit");
      else if (!stopping) chunks.push(data);
    };
    child.stdout.on("data", retain);
    child.stderr.on("data", retain);
    child.once("error", () => {
      if (child.pid === undefined) finish("unusable", true);
      else stop("unusable");
    });
    child.once("close", (code) =>
      finish(
        reason ??
          (code === 0 && spec.version.test(Buffer.concat(chunks).toString("utf8"))
            ? "present"
            : "unusable"),
        true,
      ),
    );
  });
}

export async function nativeAvailability() {
  const tools: Record<Tool, Fact> = {
    perf: { state: "not-checked", closed: true },
    gdb: { state: "not-checked", closed: true },
    ss: { state: "not-checked", closed: true },
  };
  if (process.platform === "linux") {
    for (const tool of ["perf", "gdb", "ss"] as const) {
      try {
        tools[tool] = await check(tool);
      } catch {
        tools[tool] = { state: "unusable", closed: true };
      }
      if (!tools[tool].closed) break;
    }
  }
  const closed = Object.values(tools).every((fact) => fact.closed);
  const perf = closed && tools.perf.state === "present",
    ss = closed && tools.ss.state === "present";
  return {
    diagnostic: "native-control-availability",
    status: perf ? "candidate" : "unavailable",
    host: process.platform === "linux" ? "linux" : "unsupported",
    tools,
    permission: "unproven",
    symbols: "unproven",
    nativeFrames: "unproven",
    next: perf ? "perf-control" : ss ? "owned-role-control" : "stop",
  };
}

if (import.meta.main) {
  const result = await nativeAvailability();
  // Closed data only; never raw tool output, errors, paths, process identifiers or operands.
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "candidate" ? 0 : 2;
}
