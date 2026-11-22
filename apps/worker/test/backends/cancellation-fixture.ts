import type { WorkspaceRuntimeResult } from "@cloudflare/computer";

// Relative paths use the real execution's /workspace cwd (a temporary directory in the host control).
// The descendant cannot finish naturally before the cancellation request. Only the observer releases it.
export const cancellationGroupSource =
  "set -eu\n(while [ ! -e pg-release ]; do sleep 0.05; done; printf orphan > pg-survived) &\nprintf ready > pg-ready\nwait\n";
export const cancellationObserverSource =
  "set -eu\nprintf release > pg-release\nsleep 4\ntest ! -e pg-survived\nprintf process-group-stopped\n";

/** Fixed fields only: no process output, paths or upstream error text enter CI diagnostics. */
export function cancellationDiagnostic(
  phase: "cancel" | "observer",
  result: Pick<WorkspaceRuntimeResult<"utf8">, "status" | "exitCode" | "sync" | "skipped">,
  readyPulls: number,
  readyElapsedMs: number,
) {
  return {
    probe: "process-group-cancellation",
    phase,
    status: result.status,
    exitCode: result.exitCode,
    syncStatus: result.sync.status,
    skippedCount: result.skipped.length,
    syncSkippedCount: result.sync.skipped.length,
    syncErrorPresent: result.sync.status === "pending" && result.sync.error !== undefined,
    readyPulls,
    readyElapsedMs,
  };
}
