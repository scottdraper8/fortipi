import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import {
  powershellArgs,
  windowsUtilityEnvironment,
} from "../packages/fortipi-executor/src/platform/windows.ts";

const execute = promisify(execFile);
const windowsProcessFailures = {
  "command-stopped": "Unable to verify the owned Windows hardener process (command-stopped)",
  "command-launch": "Unable to verify the owned Windows hardener process (command-launch)",
  "command-unavailable":
    "Unable to verify the owned Windows hardener process (command-unavailable)",
  "command-exit": "Unable to verify the owned Windows hardener process (command-exit)",
  "command-output-limit":
    "Unable to verify the owned Windows hardener process (command-output-limit)",
  "json-parse": "Unable to verify the owned Windows hardener process (json-parse)",
  "json-shape": "Unable to verify the owned Windows hardener process (json-shape)",
} as const;
type WindowsCommandFailure = Exclude<
  keyof typeof windowsProcessFailures,
  "json-parse" | "json-shape"
>;

function ownErrorField(error: unknown, field: string): unknown {
  try {
    if (error && typeof error === "object")
      return Object.getOwnPropertyDescriptor(error, field)?.value;
  } catch {}
  return undefined;
}

/** Classification only: a stopped command is not proof of a timeout. */
export function windowsHealthCommandFailure(error: unknown): WindowsCommandFailure {
  const code = ownErrorField(error, "code");
  // maxBuffer can also kill the child; it must win over the stopped classification.
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "command-output-limit";
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return "command-launch";
  const signal = ownErrorField(error, "signal");
  if (
    ownErrorField(error, "killed") === true ||
    (typeof signal === "string" && ["SIGTERM", "SIGKILL", "SIGINT", "SIGBREAK"].includes(signal))
  )
    return "command-stopped";
  if (typeof code === "number" && Number.isSafeInteger(code) && code !== 0) return "command-exit";
  return "command-unavailable";
}

interface WindowsProcessObservation {
  pid: number;
  path: string;
  startedAt: string;
}

/** Output stays private; errors select fixed labels without exposing parsed values. */
export function parseWindowsHealthProcess(output: string): WindowsProcessObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(windowsProcessFailures["json-parse"]);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(windowsProcessFailures["json-shape"]);
  const fields = parsed as Record<string, unknown>;
  if (
    typeof fields.pid !== "number" ||
    typeof fields.path !== "string" ||
    typeof fields.startedAt !== "string"
  )
    throw new Error(windowsProcessFailures["json-shape"]);
  return parsed as WindowsProcessObservation;
}

const fixedHealthFailures = new Set([
  ...Object.values(windowsProcessFailures),
  "Runner hardener observation is outside the current job window",
  "Runner hardener PID changed",
  "Runner hardener executable identity differs",
  "Runner hardener bytes differ from the reviewed vendor archive",
  "Runner annotations are incomplete",
  "Runner reported a failure annotation",
  "Current-job read token is required",
  "Runner hardener verification unavailable (job-metadata)",
  "Runner hardener verification unavailable (runner-annotations)",
  "Runner hardener verification unavailable (reported-runner-failure-or-incomplete-annotations)",
  "Unable to verify current-job hardener file metadata",
  "Unable to verify the macOS StepSecurity network extension",
  "macOS StepSecurity network extension is not activated and enabled",
  "The reviewed Windows hardener supports x64 only",
  "Unable to read the owned Windows hardener PID",
  "Invalid owned hardener PID",
  "Unable to verify reviewed Windows hardener bytes",
  "Unable to verify the owned Windows hardener process",
  "Runner reached deliberately unallowed destination; block enforcement is required",
]);

/** Exact source-owned messages only; never coerce errors or inspect causes/diagnostic output. */
export function runnerHardenerFailureMessage(error: unknown): string {
  const message = ownErrorField(error, "message");
  return typeof message === "string" && fixedHealthFailures.has(message)
    ? message
    : "Runner hardener health failed; details withheld";
}

// v2.23.0 checksum.ts pins the v1.0.10-win archive to 1fada923…b4071.
// Independently hash-checked archive member; these bytes are never redistributed.
export const windowsAgent = {
  size: 8651776,
  sha256: "ed7d972bd42ca7738921295e5764b08adb4be955b8ee38aee202dac289152844",
} as const;

export interface JobWindow {
  id: number;
  startedAt: number;
  observedAt: number;
}

/** The OS must report both approved identity and an enabled, activated extension. */
export function macosNetworkExtensionActive(output: string): boolean {
  return output.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/);
    return (
      fields[0] === "*" &&
      fields[1] === "*" &&
      fields[2] === "D63S9HLM4L" &&
      fields[3] === "io.stepsecurity.harden-runner.ext" &&
      line.trimEnd().endsWith("[activated enabled]")
    );
  });
}

export function assertJobFresh(timestamp: number, window: JobWindow): void {
  assert.ok(
    Number.isFinite(timestamp) && timestamp >= window.startedAt && timestamp <= window.observedAt,
    "Runner hardener observation is outside the current job window",
  );
}

export function assertWindowsAgent(
  observation: { pid: number; path: string; startedAt: number; size: number; sha256: string },
  pid: number,
  window: JobWindow,
): void {
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647);
  assert.ok(observation.pid === pid, "Runner hardener PID changed");
  assert.ok(
    typeof observation.path === "string" &&
      win32.normalize(observation.path).toLowerCase() === "c:\\agent\\agent.exe",
    "Runner hardener executable identity differs",
  );
  assert.ok(
    observation.size === windowsAgent.size && observation.sha256 === windowsAgent.sha256,
    "Runner hardener bytes differ from the reviewed vendor archive",
  );
  assertJobFresh(observation.startedAt, window);
}

export function assertNoRunnerFailureAnnotations(value: unknown): void {
  assert.ok(Array.isArray(value) && value.length < 100, "Runner annotations are incomplete");
  for (const annotation of value) {
    assert.ok(annotation && typeof annotation === "object");
    const level = (annotation as { annotation_level?: unknown }).annotation_level;
    assert.ok(level === "notice" || level === "warning", "Runner reported a failure annotation");
  }
}

export function selectNativeJobWindow(
  value: unknown,
  expected: { repository: string; runId: number; name: string; runnerName: string },
  observedAt: number,
): JobWindow & { annotationsURL: string } {
  assert.ok(typeof expected.runnerName === "string" && expected.runnerName.trim().length > 0);
  assert.ok(value && typeof value === "object");
  const result = value as { total_count?: unknown; jobs?: unknown };
  assert.ok(Array.isArray(result.jobs) && result.jobs.length <= 100);
  assert.ok(result.total_count === result.jobs.length);
  const jobs = result.jobs.map((entry: unknown) => {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
    return entry as Record<string, unknown>;
  });
  const matches = jobs.filter((entry) => entry.name === expected.name);
  assert.ok(matches.length === 1);
  const entry = matches[0];
  assert.ok(entry);
  assert.ok(entry.run_id === expected.runId && entry.status === "in_progress");
  assert.ok(entry.conclusion === null && entry.completed_at === null);
  assert.ok(typeof entry.runner_name === "string" && entry.runner_name.trim().length > 0);
  assert.ok(entry.runner_name === expected.runnerName);
  assert.ok(typeof entry.id === "number" && Number.isSafeInteger(entry.id) && entry.id > 0);
  const checkPrefix = `https://api.github.com/repos/${expected.repository}/check-runs/`;
  assert.ok(typeof entry.check_run_url === "string" && entry.check_run_url.startsWith(checkPrefix));
  assert.ok(/^[1-9][0-9]*$/.test(entry.check_run_url.slice(checkPrefix.length)));
  assert.ok(typeof entry.started_at === "string");
  const startedAt = Date.parse(entry.started_at);
  assert.ok(
    Number.isFinite(observedAt) &&
      Number.isFinite(startedAt) &&
      startedAt > 0 &&
      startedAt <= observedAt,
  );
  return {
    id: entry.id,
    startedAt,
    observedAt,
    annotationsURL: `${entry.check_run_url}/annotations?per_page=100`,
  };
}

/** Read current job metadata and reported failures once, with an ephemeral read-only token. */
async function currentJobWindow(): Promise<JobWindow> {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt } = process.env;
  assert.ok(
    process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
  );
  assert.ok(typeof repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo));
  assert.ok(/^[1-9][0-9]*$/.test(run ?? "") && /^[1-9][0-9]*$/.test(attempt ?? ""));
  assert.ok(process.env.GITHUB_TOKEN, "Current-job read token is required");
  const job = process.env.GITHUB_JOB;
  assert.ok(job === "native-executor" || job === "native");
  const os = process.platform === "darwin" ? "macos-15" : "windows-2025";
  const name = `${job} (${os})`;
  const runnerName = process.env.RUNNER_NAME;
  assert.ok(typeof runnerName === "string" && runnerName.trim().length > 0);
  let phase = "job-metadata";
  try {
    const read = async (url: string): Promise<unknown> => {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      assert.ok(response.ok && response.body);
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        assert.ok(length <= 500_000);
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
    };
    const result = await read(
      `https://api.github.com/repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`,
    );
    const window = selectNativeJobWindow(
      result,
      { repository: repo, runId: Number(run), name, runnerName },
      Date.now(),
    );
    // Vendor core.error() can leave an action successful despite failed installation.
    // Inspect levels only; never expose annotation messages, paths or credentials.
    phase = "runner-annotations";
    const annotations = await read(window.annotationsURL);
    phase = "reported-runner-failure-or-incomplete-annotations";
    assertNoRunnerFailureAnnotations(annotations);
    return window;
  } catch {
    throw new Error(`Runner hardener verification unavailable (${phase})`);
  }
}

async function freshFile(path: string, window: JobWindow, maxSize: number) {
  try {
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maxSize);
    assertJobFresh(info.mtimeMs, { ...window, observedAt: Date.now() });
    return info;
  } catch {
    throw new Error("Unable to verify current-job hardener file metadata");
  }
}

export async function nativeRunnerHealth(): Promise<void> {
  assert.ok(process.platform === "darwin" || process.platform === "win32");
  const window = await currentJobWindow();
  if (process.platform === "darwin") {
    // Configuration contents include vendor credentials: inspect metadata only.
    await freshFile("/opt/step-security/agent.json", window, 1_000_000);
    let output: string;
    try {
      output = (
        await execute("/usr/bin/systemextensionsctl", ["list"], {
          timeout: 5000,
          maxBuffer: 65536,
          env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        })
      ).stdout;
    } catch {
      throw new Error("Unable to verify the macOS StepSecurity network extension");
    }
    assert.ok(
      macosNetworkExtensionActive(output),
      "macOS StepSecurity network extension is not activated and enabled",
    );
  } else {
    assert.ok(process.arch === "x64", "The reviewed Windows hardener supports x64 only");
    await freshFile("C:\\agent\\config.json", window, 1_000_000);
    await freshFile("C:\\agent\\agent.pid", window, 16);
    let text: string;
    try {
      text = await readFile("C:\\agent\\agent.pid", "utf8");
    } catch {
      throw new Error("Unable to read the owned Windows hardener PID");
    }
    assert.ok(/^[1-9][0-9]{0,9}$/.test(text), "Invalid owned hardener PID");
    const pid = Number(text);
    assert.ok(Number.isSafeInteger(pid) && pid <= 2147483647);
    const binary = "C:\\agent\\agent.exe";
    let sha256: string;
    try {
      const info = await lstat(binary);
      assert.ok(info.isFile() && !info.isSymbolicLink() && info.size === windowsAgent.size);
      sha256 = createHash("sha256")
        .update(await readFile(binary))
        .digest("hex");
    } catch {
      throw new Error("Unable to verify reviewed Windows hardener bytes");
    }
    let stdout: string;
    try {
      const script = `$ErrorActionPreference = 'Stop'; $p = Get-Process -Id ${pid}; @{ pid = $p.Id; path = $p.Path; startedAt = $p.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress`;
      const pending = execute(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        powershellArgs(script),
        {
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 16384,
          env: windowsUtilityEnvironment(),
        },
      );
      pending.child.stdin?.on("error", () => {});
      pending.child.stdin?.end(); // No input: deliver EOF as the existing Windows adapter does.
      ({ stdout } = await pending);
    } catch (error) {
      throw new Error(windowsProcessFailures[windowsHealthCommandFailure(error)]);
    }
    const observation = parseWindowsHealthProcess(stdout);
    assertWindowsAgent(
      {
        ...observation,
        startedAt: Date.parse(observation.startedAt),
        size: windowsAgent.size,
        sha256,
      },
      pid,
      { ...window, observedAt: Date.now() },
    );
  }
  console.log(
    JSON.stringify({
      phase: "runner-hardener",
      platform: process.platform,
      mode: "audit",
      jobId: window.id,
      jobStartedAt: new Date(window.startedAt).toISOString(),
      health: "observed-installation-and-activity",
      policyLoaded: "unverified",
      eventDelivery: "unverified",
    }),
  );
}
