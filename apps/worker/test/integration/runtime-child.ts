import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Observe process names/ancestry only: argv and environments may contain roles. */
export async function killRuntime(pid: number, abrupt: boolean): Promise<void> {
  if (process.platform === "win32") {
    await promisify(execFile)("taskkill", ["/PID", String(pid), "/T", ...(abrupt ? ["/F"] : [])]);
    return;
  }
  if (abrupt) {
    const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,ppid=,pgid=,comm="]);
    assert.ok(
      stdout.split("\n").some((line) => {
        const fields = line.trim().split(/\s+/);
        return Number(fields[2]) === pid && fields.slice(3).join(" ").includes("workerd");
      }),
      "Abrupt recovery must kill an actual workerd in the managed process group",
    );
  }
  process.kill(-pid, abrupt ? "SIGKILL" : "SIGTERM");
}
