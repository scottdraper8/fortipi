import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root, workspaceConfig } from "./harness.ts";

/** Pinned Wrangler CLI, actual persistent SQLite directory, abrupt complete process-tree termination. */
export class RecoveryProcess {
  readonly directory: string;
  private child: ChildProcess | undefined;
  private diagnostics = "";
  url = "";
  constructor(directory: string) {
    this.directory = directory;
  }
  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const configPath = resolve(this.directory, "wrangler.json");
    await writeFile(configPath, JSON.stringify(workspaceConfig()));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No disposable port");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      WRANGLER_SEND_METRICS: "false",
      XDG_CONFIG_HOME: resolve(this.directory, "config"),
    };
    this.child = spawn(
      process.execPath,
      [
        resolve(root, "apps/worker/node_modules/wrangler/bin/wrangler.js"),
        "dev",
        "--local",
        "--persist-to",
        resolve(this.directory, "state"),
        "--config",
        configPath,
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--log-level",
        "error",
        "--show-interactive-dev-session=false",
      ],
      {
        cwd: this.directory,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child.stdout?.on("data", (bytes: Buffer) => {
      this.diagnostics = (this.diagnostics + bytes.toString()).slice(-65_536);
    });
    this.child.stderr?.on("data", (bytes: Buffer) => {
      this.diagnostics = (this.diagnostics + bytes.toString()).slice(-65_536);
    });
    this.url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null)
        throw new Error(`Wrangler process exited: ${this.diagnostics}`);
      try {
        if ((await fetch(`${this.url}/ready`, { signal: AbortSignal.timeout(500) })).ok) return;
      } catch {}
      await delay(50);
    }
    await this.kill();
    throw new Error(`Wrangler readiness timeout: ${this.diagnostics}`);
  }
  async kill(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.pid && child.exitCode === null) {
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
        });
        await new Promise<void>((resolve) => killer.once("exit", () => resolve()));
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        delay(5000).then(() => {
          throw new Error("Runtime process tree did not terminate");
        }),
      ]);
    }
    this.child = undefined;
  }
}
