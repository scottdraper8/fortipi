// Temporary diagnostic only: captured TAP is private, never Root/release authority.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ProcessResult } from "./prepare-release.ts";

const baseProductSource1d = "1d1b8774bf2d09ac3a95cee44d42792ce851c092";
const files = [
  "apps/worker/test/agent/process-recovery.test.ts",
  "apps/worker/test/control/tickets.test.ts",
  "apps/worker/test/execution/native-connected-recovery.test.ts",
  "apps/worker/test/integration/admission-recovery.test.ts",
  "scripts/test/release/application-recovery-coordinator.test.ts",
  "scripts/test/release/application-recovery-existing.test.ts",
  "scripts/test/release/platform-recovery.test.ts",
];
let actualhead: string | null = null;
let result: ProcessResult | undefined;
let complete = false;
try {
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const head = git("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error();
  actualhead = head;
  if (head !== process.env.GITHUB_SHA || git("status", "--porcelain") !== "") throw new Error();
  const allowed = new Set([
    "scripts/build-workspaces.ts",
    "scripts/prepare-release.ts",
    "scripts/source-test-processes.ts",
    "scripts/test/release/source-failure-diagnostics.test.ts",
    "scripts/linux-source-failure-probe.ts",
    ".github/workflows/linux-source-failure-probe.yml",
    "apps/worker/test/agent/process-harness.ts",
    "apps/worker/test/agent/runtime-worker.ts",
    "apps/worker/test/execution/native-process.ts",
  ]);
  if (
    git("diff", "--name-only", baseProductSource1d, head)
      .split("\n")
      .some((path) => !allowed.has(path))
  )
    throw new Error();
  const image = JSON.parse(
    await readFile("apps/worker/dist/container/image-metadata.json", "utf8"),
  );
  if (image.sourceCommit !== "8ead7a2734769d3595cd37f54067050de7c03882") throw new Error();
  const { childEnvironment, execute } = await import("./prepare-release.ts");
  const { observeSourceTestFailures } = await import("./build-workspaces.ts");
  const { sourceTestDiagnostic } = await import("./source-test-processes.ts");
  const emit = (line: string) => {
    const closed = line.trimEnd();
    if (!sourceTestDiagnostic(closed)) return;
    const prefix = closed.startsWith("# ") ? "# " : "";
    try {
      process.stdout.write(`${prefix}${JSON.stringify(JSON.parse(closed.slice(prefix.length)))}\n`);
    } catch {
      // An unavailable diagnostic cannot expose input or replace the child outcome.
    }
  };
  result = await execute(
    process.execPath,
    ["--require", "./scripts/source-test-processes.ts", "--test", "--test-reporter=tap", ...files],
    process.cwd(),
    childEnvironment(),
    15 * 60_000,
    false,
  );
  const tap = Readable.from([result.stdout]);
  const ended = once(tap, "end");
  observeSourceTestFailures(tap, emit);
  await ended;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (sourceTestDiagnostic(line)) emit(line);
    const summary =
      /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\d{1,8}(?:\.\d{1,9})?)$/.exec(
        line,
      );
    if (summary) process.stdout.write(`# ${summary[1]} ${Number(summary[2])}\n`);
  }
  complete = true;
} catch {
  // Keep all exceptions, child output, argv and environment private.
}
process.stdout.write(
  `${JSON.stringify({ actualhead, baseProductSource1d, requestedFiles: files.length, complete, code: result?.code ?? null, timedOut: result?.timedOut ?? false })}\n`,
);
process.exitCode = !complete || result?.timedOut ? 1 : (result?.code ?? 1);
