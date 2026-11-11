import { spawn } from "node:child_process";
import { chmod, lstat } from "node:fs/promises";
import type { PlatformAdapter, TreeDisposition } from "./types.js";

export function posix(platform: "linux" | "darwin"): PlatformAdapter {
  return {
    platform,
    confinement: "host",
    async protect(path, directory) {
      await chmod(path, directory ? 0o700 : 0o600);
    },
    async verifyProtection(path, directory) {
      const stat = await lstat(path);
      if (
        stat.isSymbolicLink() ||
        stat.isDirectory() !== directory ||
        (!directory && (!stat.isFile() || stat.nlink !== 1)) ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
      )
        throw new Error("unsafe executor state permissions");
    },
    async verifyEntry(_path, stat) {
      if (
        stat.isSymbolicLink() ||
        (!stat.isFile() && !stat.isDirectory()) ||
        (stat.isFile() && stat.nlink !== 1) ||
        (stat.mode & 0o7000) !== 0
      )
        throw new Error("unsafe workspace link or special file");
    },
    shell(command, cwd, env) {
      return { executable: "/bin/sh", args: ["-c", command], cwd, env };
    },
    spawn(spec) {
      return spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    async cancel(child, graceMs): Promise<TreeDisposition> {
      // Only the live ChildProcess from this incarnation authorizes a kill. Never a recovered PID.
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return { state: "unknown", possibleExternalEffects: true };
      const pid = child.pid;
      let closed = false;
      const onClose = () => {
        closed = true;
      };
      child.once("close", onClose);
      try {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          return { state: "unknown", possibleExternalEffects: true };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, graceMs));
        // A leader can exit with descendants still holding pipes; process group is still ours during this call.
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            return { state: "unknown", possibleExternalEffects: true };
        }
        if (!closed)
          await Promise.race([
            new Promise<void>((resolve) => child.once("close", () => resolve())),
            new Promise<void>((resolve) => setTimeout(resolve, 1000)),
          ]);
        return { state: closed ? "stopped" : "unknown", possibleExternalEffects: true };
      } finally {
        child.off("close", onClose);
      }
    },
  };
}
