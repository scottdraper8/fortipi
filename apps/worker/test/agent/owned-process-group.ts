import process from "node:process";

/**
 * Observation only: a reused group ID can block cleanup, never authorize a kill.
 * Zombies still count as present; only ESRCH confirms the OS barrier.
 */
export async function joinOwnedProcessGroup(pgid: number): Promise<void> {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) throw new Error("Invalid owned process group");
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Owned process group exit unconfirmed after 5000ms");
    await new Promise<void>((accept) => setTimeout(accept, Math.min(25, remaining)));
  }
}

type StartupMarker =
  | "address-in-use"
  | "module-unavailable"
  | "memory"
  | "permission"
  | "filesystem"
  | "build-service"
  | "runtime"
  | "unknown";

/** Return only a fixed marker, never captured output or a guessed prose cause. */
export function startupMarker(output: string): StartupMarker {
  const codes = new Set(
    output.match(/(?<![A-Za-z0-9_])(?:ERR_[A-Z_]+|E[A-Z0-9_]+|MODULE_NOT_FOUND)(?![A-Za-z0-9_])/g),
  );
  if (codes.has("EADDRINUSE") || codes.has("ERR_ADDRESS_IN_USE")) return "address-in-use";
  if (codes.has("ERR_MODULE_NOT_FOUND") || codes.has("MODULE_NOT_FOUND"))
    return "module-unavailable";
  if (
    ["ENOMEM", "ERR_WORKER_OUT_OF_MEMORY", "ERR_MEMORY_ALLOCATION_FAILED"].some((code) =>
      codes.has(code),
    )
  )
    return "memory";
  if (codes.has("EACCES") || codes.has("EPERM")) return "permission";
  if (
    ["ENOENT", "ENOTDIR", "EISDIR", "EMFILE", "ENFILE", "ENOSPC", "EROFS"].some((code) =>
      codes.has(code),
    )
  )
    return "filesystem";
  if (
    ["ERR_RUNTIME_FAILURE", "ERR_WORKER_INIT_FAILED", "ERR_IPC_CHANNEL_CLOSED"].some((code) =>
      codes.has(code),
    )
  )
    return "runtime";
  // No qualified public build-service code: esbuild prose alone stays unknown.
  return "unknown";
}
