import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { childEnvironment } from "../../scripts/prepare-release.ts";
import type { Installed } from "../distribution/install.ts";
import { fixtureTLS } from "./fixture-tls.ts";

async function stopTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await promisify(execFile)("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    return;
  }
  // Only current ancestry of our still-live ChildProcess authorizes cleanup.
  // Names/PIDs only: never inspect role-bearing argv or environments.
  const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,ppid=,comm="]);
  const rows = stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .map((fields) => ({ pid: Number(fields[0]), parent: Number(fields[1]) }));
  const owned = new Set([child.pid]);
  for (let old = -1; old !== owned.size; ) {
    old = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  }
  for (const pid of [...owned].reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
async function browserProcess(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let stdout = "",
    timedOut = false,
    escalation: NodeJS.Timeout | undefined;
  const stop = () => {
    if (timedOut) return;
    timedOut = true;
    child.kill("SIGTERM");
    escalation = setTimeout(() => {
      void stopTree(child).catch(() => child.kill("SIGKILL"));
    }, 30000);
  };
  const timer = setTimeout(stop, 270000);
  child.stdout.on("data", (bytes: Buffer) => {
    if (Buffer.byteLength(stdout) + bytes.length > 1048576) stop();
    else stdout += bytes.toString();
  });
  try {
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", () => reject(new Error("Browser coordinator unavailable")));
      child.once("close", accept);
    });
    return { code, stdout, timedOut };
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
  }
}

/** Node reads NODE_EXTRA_CA_CERTS only at startup. Isolate fixture trust in this
 * dedicated coordinator child, never the parent, clients or system trust store. */
export async function localBrowser(installed: Installed) {
  await installed.verifyUnchanged();
  const tls = await fixtureTLS();
  try {
    const description = resolve(tls.directory, "tls.json");
    await writeFile(description, JSON.stringify(tls), { flag: "wx", mode: 0o600 });
    // Select the pinned public Playwright cache explicitly. This
    // names public tool bytes, never a user's Chromium profile or auth state.
    let revision = chromium.executablePath();
    while (!/^chromium-\d+$/.test(basename(revision))) {
      assert.notEqual(dirname(revision), revision, "Matched Chromium revision directory required");
      revision = dirname(revision);
    }
    const result = await browserProcess(
      [
        resolve(import.meta.dirname, "fixtures/browser-child.ts"),
        installed.manifestPath,
        installed.consumer,
        installed.hash,
        description,
      ],
      tls.directory,
      childEnvironment({
        XDG_CONFIG_HOME: resolve(tls.directory, "config"),
        XDG_CACHE_HOME: resolve(tls.directory, "cache"),
        LOCALAPPDATA: resolve(tls.directory, "local"),
        APPDATA: resolve(tls.directory, "roaming"),
        NODE_EXTRA_CA_CERTS: tls.ca,
        PLAYWRIGHT_BROWSERS_PATH: dirname(revision),
      }),
    );
    await installed.verifyUnchanged();
    assert.equal(result.timedOut, false, "Local HTTPS browser coordinator timed out");
    const observed = JSON.parse(result.stdout) as {
      outcome: string;
      stage: string;
      errorClass?: string;
      errorCode?: string;
      cleanupComplete?: boolean;
      diagnostic?: Record<string, unknown>;
      observation?: Record<string, unknown>;
    };
    assert.equal(
      result.code,
      0,
      `Local HTTPS browser phase failed: ${observed.stage}/${observed.errorClass}/${observed.errorCode ?? "unclassified"}; cleanupComplete=${observed.cleanupComplete ?? true}; diagnostic=${JSON.stringify(observed.diagnostic ?? null)}`,
    );
    assert.equal(observed.outcome, "pass");
    assert.ok(observed.observation);
    return observed.observation;
  } finally {
    await rm(tls.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
