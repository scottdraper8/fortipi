// Temporary diagnostic only: captured TAP is private, never Root/release authority.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ProcessResult } from "./prepare-release.ts";

const productSource = "5f48b4b12296b630486ccf5904533175b6fda913";
const files = [
  "apps/worker/test/agent/process-recovery.test.ts",
  "apps/worker/test/execution/native-connected-recovery.test.ts",
  "apps/worker/test/integration/admission-recovery.test.ts",
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
    "scripts/source-test-processes.ts",
    "scripts/linux-source-failure-probe.ts",
    ".github/workflows/linux-source-failure-probe.yml",
    "apps/worker/test/agent/process-harness.ts",
    "apps/worker/test/agent/runtime-worker.ts",
    "apps/worker/test/integration/oracles.ts",
    "apps/worker/test/execution/native-process.ts",
    "apps/worker/test/integration/runtime.ts",
    "apps/worker/test/integration/fixture-worker.ts",
    "scripts/source-pi-open-probe.ts",
  ]);
  if (
    git("diff", "--name-only", productSource, head)
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
    childEnvironment(
      process.env.FORTIPI_SOURCE_PI_OPEN_DIAGNOSTICS === "1"
        ? { FORTIPI_SOURCE_PI_OPEN_DIAGNOSTICS: "1" }
        : {},
    ),
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
  `${JSON.stringify({ actualhead, productSource, requestedFiles: files.length, complete, code: result?.code ?? null, timedOut: result?.timedOut ?? false })}\n`,
);
process.exitCode = !complete || result?.timedOut ? 1 : (result?.code ?? 1);
