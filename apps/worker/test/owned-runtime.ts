// Test-only process ownership. Never imported by product/runtime packages.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { joinOwnedProcessGroup } from "./agent/owned-process-group.ts";

export interface OwnedRuntime {
  readonly root: ChildProcess;
  /** The actual command's exit, independent of the supervisor's lifetime. */
  readonly exited: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly spawnError: boolean;
  readonly innerExit: Promise<void>;
  readonly closed: Promise<void>;
  stop(
    signal: "SIGTERM" | "SIGKILL",
    options?: { requireWorkerd?: string; closeTimeoutMs?: number },
  ): Promise<void>;
}

/** A live detached root owns the group even after the forwarding CLI exits. */
export function spawnOwnedRuntime(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): OwnedRuntime {
  const root = spawn(process.execPath, [fileURLToPath(import.meta.url), "--owned-runtime"], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let exited = false,
    exitCode: number | null = null,
    signalCode: NodeJS.Signals | null = null,
    spawnError = false;
  let resolveInner: () => void = () => {};
  const innerExit = new Promise<void>((accept) => {
    resolveInner = accept;
  });
  const closed = new Promise<void>((accept) => root.once("close", () => accept()));
  root.on("error", () => {
    spawnError = true;
    exited = true;
    resolveInner();
  });
  root.on("message", (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || exited) return;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join() === "type" && record.type === "inner-error") {
      spawnError = true;
      exited = true;
    } else if (
      Object.keys(record).sort().join() === "code,signal,type" &&
      record.type === "inner-exit" &&
      (record.code === null ||
        (typeof record.code === "number" &&
          Number.isInteger(record.code) &&
          Math.abs(record.code) <= 255)) &&
      (record.signal === null ||
        (typeof record.signal === "string" && /^SIG[A-Z0-9]{1,8}$/.test(record.signal)))
    ) {
      exited = true;
      exitCode = record.code as number | null;
      signalCode = record.signal as NodeJS.Signals | null;
    } else return;
    resolveInner();
  });
  root.send({ type: "run", args }, (error) => {
    if (error) {
      spawnError = true;
      exited = true;
      resolveInner();
    }
  });
  let stopping: Promise<void> | undefined;
  return {
    root,
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    get spawnError() {
      return spawnError;
    },
    innerExit,
    closed,
    stop(signal, stopOptions = {}) {
      stopping ??= (async () => {
        if (!root.pid) {
          await closed;
          return;
        }
        const live = () => root.exitCode === null && root.signalCode === null;
        if (
          signal === "SIGKILL" &&
          stopOptions.requireWorkerd &&
          live() &&
          process.platform !== "win32"
        ) {
          const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,ppid=,pgid=,comm="]);
          assert.ok(
            stdout.split("\n").some((row) => {
              const fields = row.trim().split(/\s+/);
              return (
                Number(fields[2]) === root.pid && fields.slice(3).join(" ").includes("workerd")
              );
            }),
            stopOptions.requireWorkerd,
          );
        }
        // Recheck AFTER any awaited witness. A dead/reused numeric group is never signalled.
        if (live()) {
          if (process.platform === "win32") {
            await promisify(execFile)("taskkill", [
              "/PID",
              String(root.pid),
              "/T",
              ...(signal === "SIGKILL" ? ["/F"] : []),
            ]);
          } else {
            try {
              process.kill(-root.pid, signal);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH" || live()) throw error;
            }
          }
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Owned runtime streams did not close")),
                stopOptions.closeTimeoutMs ?? 5000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        // Preserve each caller's complete close budget before the separate
        // existing five-second group-disappearance observation begins.
        if (process.platform !== "win32") await joinOwnedProcessGroup(root.pid);
        if (signal === "SIGKILL" && process.platform !== "win32")
          assert.equal(root.signalCode, "SIGKILL");
      })();
      return stopping;
    },
  };
}

function supervise(): void {
  let command: ChildProcess | undefined,
    stopping = false,
    commandClosed = false,
    started = false;
  const finish = () => {
    if (stopping && (!started || commandClosed)) {
      if (process.connected) process.disconnect?.();
      process.exitCode = 0;
    }
  };
  // Parent signals the currently live group. Do not exit until descendant-held
  // command pipes reach EOF; ChildProcess.close follows exit AND stdio closure.
  process.on("SIGTERM", () => {
    stopping = true;
    finish();
  });
  process.on("disconnect", () => {
    if (stopping) return;
    stopping = true;
    if (process.platform !== "win32") process.kill(-process.pid, "SIGTERM");
    else command?.kill("SIGTERM");
    finish();
  });
  process.on("message", (value: unknown) => {
    if (started || stopping || !value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join() !== "args,type" ||
      record.type !== "run" ||
      !Array.isArray(record.args) ||
      record.args.length === 0 ||
      record.args.length > 128 ||
      !record.args.every((arg) => typeof arg === "string" && arg.length <= 8192)
    )
      return;
    started = true;
    command = spawn(process.execPath, record.args as string[], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    command.stdout?.pipe(process.stdout, { end: false });
    command.stderr?.pipe(process.stderr, { end: false });
    // The command's IPC is deliberately not forwarded. Only these closed facts
    // traverse the private parent channel, never arbitrary Wrangler messages.
    const send = (record: object) => {
      if (process.connected) process.send?.(record, () => {});
    };
    command.once("error", () => send({ type: "inner-error" }));
    command.once("exit", (code, signal) => send({ type: "inner-exit", code, signal }));
    command.once("close", () => {
      commandClosed = true;
      finish();
    });
  });
}

if (process.argv[2] === "--owned-runtime" && process.send) supervise();
