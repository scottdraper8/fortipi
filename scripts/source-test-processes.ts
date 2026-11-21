import { ChildProcess } from "node:child_process";
import { subscribe } from "node:diagnostics_channel";
import { lstatSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelObservation } from "./owned-runtime-roles.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testPath =
  /^(?:packages\/fortipi-[a-z]+\/test|apps\/worker\/test|scripts\/test\/release|tests\/clients)\/[A-Za-z0-9._/-]+\.(?:test|spec)\.ts$/;

/** Repository test paths only; callers outside these roots stay unidentified. */
export function sourceRecoveryPath(argument = process.argv[1]): string | null {
  if (!argument) return null;
  const path = relative(root, resolve(argument)).replaceAll("\\", "/");
  return testPath.test(path) && !path.split("/").includes("..") ? path : null;
}

const selected = new Map<string, string>();
for (const argument of process.argv.slice(1)) {
  const path = relative(root, argument).replaceAll("\\", "/");
  if (testPath.test(path) && !path.split("/").includes("..")) selected.set(resolve(argument), path);
}

// Only the test driver observes its own direct children. Never print argv,
// environment, child output, arbitrary paths or library error descriptions.
if (process.execArgv.includes("--test") && selected.size > 0 && selected.size <= 512) {
  const began = performance.now();
  let active = 0;
  const emit = (record: Record<string, string | number | null>) =>
    process.stderr.write(`${JSON.stringify(record)}\n`);
  emit({
    diagnostic: "source-test-host",
    node: process.versions.node,
    availableParallelism: availableParallelism(),
    files: selected.size,
  });
  subscribe("child_process", (message: unknown) => {
    if (message === null || typeof message !== "object") return;
    const child = (message as { process?: ChildProcess }).process;
    if (!(child instanceof ChildProcess)) return;
    child.once("spawn", () => {
      const matches = child.spawnargs.flatMap((argument) => {
        const path = selected.get(resolve(argument));
        return path === undefined ? [] : [path];
      });
      if (matches.length !== 1) return;
      const path = matches[0];
      if (path === undefined) return;
      active++;
      emit({
        diagnostic: "source-test-process",
        event: "spawn",
        path,
        elapsedMs: Math.round(performance.now() - began),
        active,
        code: null,
        signal: null,
      });
      child.once("exit", (code, signal) => {
        active--;
        emit({
          diagnostic: "source-test-process",
          event: "exit",
          path,
          elapsedMs: Math.round(performance.now() - began),
          active,
          code: Number.isInteger(code) && code !== null && Math.abs(code) <= 255 ? code : null,
          signal: signal === null || /^SIG[A-Z0-9]{1,8}$/.test(signal) ? signal : "other",
        });
      });
    });
  });
}

// Reviewed literal names only. New/dynamic/private names remain null; this is
// diagnostic data, never an assertion result or release authority.
const admissionFailureName =
  "integrated persistent runtime retains actual Pi input and repairs the same admission across both acknowledged SIGKILL boundaries";
const failureNames = new Set<string>([
  "an RPC callback can reenter its pending initialization more than once",
  "actual PiHarness fixed wake preserves sleeping work across an older idle outcome",
  "production Recovery supersession preserves distinct successor and bounded rows",
  "production Recovery hung takeover preserves distinct successor and bounded rows",
  "SAFE attempted boundary survives real service SIGKILL with retained execution identity",
  "SAFE assign-ack boundary survives real service SIGKILL with retained execution identity",
  "SAFE result boundary survives real service SIGKILL with retained execution identity",
  "SAFE receipt boundary survives real service SIGKILL with retained execution identity",
  "trusted outer recovery preserves original receipts and child byte closure across perform/readonly verification",
  "selection ownership and custody authenticate the failed initial job window before any decryption",
  "completed initial/A/B/cleanup records authenticate current jobs and immutable exact member bytes; historical run must complete",
  "cleanup retains the exact initial provider observation while its own timestamp belongs to the cleanup job",
  "reference/source/latest attempt/job/runner/window guards reject before artifact payload; generic live producer still requires completed run",
  "actual ZIP digest/namespace/member hashes and post-await main/attempt/expiry refuse inconsistent phase bytes; custody is initial-bound and separate",
  "public record byte boundary and closed metadata reject authenticated oversize/extra authority fields",
  "cleanup-only ownership accepts completed failed/cancelled initial jobs without granting phase/custody proof; missing and unfinished ownership remain unavailable",
  "Agent-first running recovery completes after a real registered query-boundary handoff",
  "A real offline running query disproves unconditional completion and uses public reconciliation",
  "actual workerd Inspector observes delayed-publication cancellation and shutdown",
  "real Pi tool attaches one child and waits without acquiring execution before approval",
  "candidate safe wrapper recovers one actual native execution across service SIGKILL and changed receipt closure",
  "standalone readiness refuses a foreign listener after actual runtime death",
  "SIGKILL/reopen preserves canary, allocation provenance and stable accepted input",
  "premature cues from held or rejected marker transactions cannot become historical proof",
  "kill cues match only the exact run, agent, phase, arm and actor generation; no storage proof",
  "ticket-only consume is atomic and binds audience, destination, Origin and expiry",
  "actual failed HTTP upgrade spends a ticket; CORS admits only exact configured HTTPS origins",
  admissionFailureName,
  "unfinished actual Pi task completes through Lifecycle after ungraceful same-storage reopen",
  "actual provider perform/verify plus matching files produces one closed relative combined proof, never qualifies on perform",
  "out-of-order/concurrent phases and uncertain perform never trigger automatic new effects",
  "matching provider flags cannot qualify missing after files or replaced original before anchors",
  "completed live HTTP/ZIP lineage replays readonly from private mode-restored copies kept until explicit disposal",
  "failed/superseded producer, foreign/different ZIP, cached-gate substitution and missing or tampered retained facts fail before provider reads",
  "fresh provider V0 drift refuses lineage without writes or changes to the original journal",
  "provider phase retains same-byte new-version intent, never qualifies app recovery; verification is strictly read-only",
  "uncertain writes reconcile exact retained intent, without repeating upload or deployment",
  "historical transition and digest share one snapshot across provider awaits",
  "candidate/prepared identity, distinct version and inherited module/binding/namespace/secret guards fail before deployment",
  "candidate SAFE assign-ack recovery with executor reconnected before Agent activation",
  "candidate SAFE result recovery with executor reconnected before Agent activation",
  "candidate SAFE receipt recovery with executor reconnected before Agent activation",
]);
const failurePaths = new Set<string>([
  "apps/worker/test/agent/runtime-reentry.test.ts",
  "apps/worker/test/agent/reentry-worker.ts",
  "apps/worker/test/agent/pi-fixed-wake.test.ts",
  "apps/worker/test/agent/pi-fixed-wake-worker.ts",
  "apps/worker/test/agent/recovery-generation.test.ts",
  "scripts/test/release/live-recovery-evidence.test.ts",
  "scripts/test/release/device-phase-artifacts.test.ts",
  "apps/worker/test/agent/workerd-inspector-races.test.ts",
  "apps/worker/test/execution/approval.test.ts",
  "apps/worker/test/agent/process-recovery.test.ts",
  "apps/worker/test/control/tickets.test.ts",
  "apps/worker/test/execution/native-connected-recovery.test.ts",
  "apps/worker/test/integration/admission-recovery.test.ts",
  "apps/worker/test/integration/oracles.ts",
  "apps/worker/test/integration/runtime.ts",
  "scripts/test/release/application-recovery-coordinator.test.ts",
  "scripts/test/release/application-recovery-existing.test.ts",
  "scripts/test/release/platform-recovery.test.ts",
  "scripts/build-workspaces.ts",
  "scripts/prepare-release.ts",
  "scripts/verify-release-gates.ts",
  "scripts/platform-recovery.ts",
  "scripts/application-recovery-coordinator.ts",
  "scripts/application-recovery-existing.ts",
  "apps/worker/test/agent/process-harness.ts",
  "apps/worker/test/agent/harness.ts",
  "apps/worker/test/execution/native-process.ts",
  "apps/worker/test/execution/native-service.ts",
]);
const failureCategories = new Set([
  "testCodeFailure",
  "testTimeoutFailure",
  "cancelledByParent",
  "subtestsFailed",
  "hookFailed",
]);
const failureCodes = new Set([
  "ERR_ASSERTION",
  "ERR_TEST_FAILURE",
  "ABORT_ERR",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);
const sourceLines = new Map<string, string[] | null>();
function validSourceLocation(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(.*):(\d{1,6}):(\d{1,6})$/.exec(value);
  if (!match || !failurePaths.has(match[1] ?? "")) return false;
  const path = match[1] as string;
  if (!sourceLines.has(path)) {
    let lines: string[] | null = null;
    try {
      const file = resolve(root, path),
        stat = lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_000_000)
        lines = readFileSync(file, "utf8").split("\n");
    } catch {
      /* Missing source is unavailable, never an arbitrary path. */
    }
    sourceLines.set(path, lines);
  }
  const line = sourceLines.get(path)?.[Number(match[2]) - 1];
  return line !== undefined && Number(match[3]) >= 1 && Number(match[3]) <= line.length + 1;
}
function sourceLocation(line: string): string | null {
  const match =
    /((?:file:\/\/|[A-Za-z]:[\\/]|\/|(?:apps|scripts)\/)[^\s()'"<>]+):(\d{1,6}):(\d{1,6})(?=[\s)'"<>]|$)/.exec(
      line,
    );
  if (!match) return null;
  try {
    const file = match[1]?.startsWith("file://")
      ? fileURLToPath(match[1])
      : resolve(root, match[1] ?? "");
    const location = `${relative(root, file).replaceAll("\\", "/")}:${match[2]}:${match[3]}`;
    return validSourceLocation(location) ? location : null;
  } catch {
    return null;
  }
}
/** Fixed failure facts only; error messages, stacks and unknown names are excluded. */
export function sourceReentryFailureLine(
  phase: unknown,
  error: unknown,
  elapsedMs: number,
): string {
  let name: unknown, code: unknown;
  try {
    if (error !== null && typeof error === "object") {
      name = (error as { name?: unknown }).name;
      code = (error as { code?: unknown }).code;
    }
  } catch {
    // An error object's accessor cannot interfere with the original failure.
  }
  return JSON.stringify({
    diagnostic: "source-reentry-failure",
    phase:
      typeof phase === "string" &&
      ["listen", "fetch-once", "fetch-twice", "close", "close-harness", "close-directory"].includes(
        phase,
      )
        ? phase
        : "unknown",
    kind:
      name === "TimeoutError"
        ? "timeout"
        : name === "AbortError"
          ? "abort"
          : name === "AssertionError"
            ? "assertion"
            : code === "ENOTEMPTY"
              ? "directory-not-empty"
              : code === "EBUSY"
                ? "resource-busy"
                : code === "EPERM" || code === "EACCES"
                  ? "permission"
                  : code === "EMFILE" || code === "ENFILE"
                    ? "file-limit"
                    : "other",
    elapsedMs: Number.isFinite(elapsedMs) ? Math.min(60000, Math.max(0, Math.round(elapsedMs))) : 0,
  });
}

function failureDiagnostic(line: string): boolean {
  if (!line.startsWith('{"diagnostic":"source-test-failure",')) return false;
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
      Object.keys(record).join(",") === "diagnostic,name,location,category,code" &&
      line === JSON.stringify(record) &&
      (record.name === null ||
        (typeof record.name === "string" && failureNames.has(record.name))) &&
      (record.location === null || validSourceLocation(record.location)) &&
      (record.category === null ||
        (typeof record.category === "string" && failureCategories.has(record.category))) &&
      (record.code === null || (typeof record.code === "string" && failureCodes.has(record.code)))
    );
  } catch {
    return false;
  }
}

function admissionCallerLocation(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^apps\/worker\/test\/integration\/(?:runtime|oracles)\.ts:/.test(value) &&
    validSourceLocation(value)
  );
}
function failureCallerDiagnostic(line: string): boolean {
  if (!line.startsWith('{"diagnostic":"source-test-failure-caller",')) return false;
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
      Object.keys(record).join(",") === "diagnostic,name,location,rank,caller" &&
      line === JSON.stringify(record) &&
      record.name === admissionFailureName &&
      validSourceLocation(record.location) &&
      (record.rank === 0 || record.rank === 1) &&
      admissionCallerLocation(record.caller) &&
      record.caller !== record.location
    );
  } catch {
    return false;
  }
}

/** Consume bounded complete TAP lines; never retain or serialize error messages. */
export function sourceFailureLines(emit: (line: string) => void): (line: string) => void {
  let pending:
    | {
        diagnostic: string;
        name: string | null;
        location: string | null;
        category: string | null;
        code: string | null;
      }
    | undefined;
  let callers: string[] = [];
  let callerStack = false;
  let indent = 0,
    yaml = false,
    stack = false,
    stackLocation = false,
    records = 0;
  const flush = () => {
    if (pending && records++ < 1024) {
      emit(`${JSON.stringify(pending)}\n`);
      for (const [rank, caller] of callers.entries())
        emit(
          `${JSON.stringify({
            diagnostic: "source-test-failure-caller",
            name: pending.name,
            location: pending.location,
            rank,
            caller,
          })}\n`,
        );
    }
    pending = undefined;
    callers = [];
    callerStack = false;
    yaml = stack = stackLocation = false;
  };
  return (line) => {
    if (line.length > 512) return;
    const header = /^( {0,32})not ok \d{1,6} - (.*)$/.exec(line);
    if (header && (!pending || (header[1]?.length ?? 0) <= indent)) {
      flush();
      indent = header[1]?.length ?? 0;
      const name = header[2] ?? "";
      pending = {
        diagnostic: "source-test-failure",
        name: failureNames.has(name) ? name : null,
        location: null,
        category: null,
        code: null,
      };
    } else if (pending) {
      const prefix = " ".repeat(indent + 2);
      if (line === `${prefix}---`) yaml = true;
      else if (line === `${prefix}...`) flush();
      else if (yaml) {
        const field = line.startsWith(prefix) ? line.slice(prefix.length) : "";
        const scalar = /^(failureType|code): ['"]?([A-Za-z_]+)['"]?$/.exec(field);
        if (scalar?.[1] === "failureType" && failureCategories.has(scalar[2] ?? ""))
          pending.category = scalar[2] as string;
        if (scalar?.[1] === "code" && failureCodes.has(scalar[2] ?? ""))
          pending.code = scalar[2] as string;
        if (field.startsWith("stack:")) stack = true;
        if (field && !field.startsWith("  ")) callerStack = field.startsWith("stack:");
        const location = field.startsWith("location:") || stack ? sourceLocation(line) : null;
        if (location && !stackLocation) {
          pending.location = location;
          stackLocation = stack;
        } else if (
          callerStack &&
          field.startsWith("  ") &&
          pending.name === admissionFailureName &&
          admissionCallerLocation(location) &&
          location !== pending.location &&
          callers.length < 2 &&
          !callers.includes(location)
        ) {
          callers.push(location);
        }
      }
    }
  };
}

/** Accept only the fixed nonsecret records emitted above, never raw stderr. */
export function sourceTestDiagnostic(line: string): boolean {
  if (line.length > 512) return false;
  return (
    /^\{"diagnostic":"source-test-host","node":"\d{1,3}\.\d{1,3}\.\d{1,3}","availableParallelism":\d{1,4},"files":\d{1,3}\}$/.test(
      line,
    ) ||
    (/^\{"diagnostic":"source-test-process","event":"(?:spawn|exit)","path":"(?:packages\/fortipi-[a-z]+\/test|apps\/worker\/test|scripts\/test\/release|tests\/clients)\/[A-Za-z0-9._/-]+\.(?:test|spec)\.ts","elapsedMs":\d{1,8},"active":\d{1,3},"code":(?:null|-?\d{1,3}),"signal":(?:null|"(?:SIG[A-Z0-9]{1,8}|other)")\}$/.test(
      line,
    ) &&
      !line.includes("../")) ||
    failureDiagnostic(line) ||
    failureCallerDiagnostic(line) ||
    /^# \{"diagnostic":"approval-phase","phase":"(?:fixture|original-approval-wait|original-approval-snapshot|original-approval-read|original-reject|original-cancel-wait|acknowledge-rejection|fresh-authority|fresh-request|fresh-approval-wait|fresh-identity|fresh-reject|fresh-cancel-wait|narrow-authority|identity-conflicts|standalone-new-job|standalone-job-read|standalone-cancel|standalone-cancel-retry|standalone-cancel-wait|final-job-read|close)","event":"aborted","elapsedMs":(?:0|[1-9]\d{0,3}|[1-5]\d{4}|60000)\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"recovery-generation-phase","mode":"(?:supersession|hung takeover)","phase":"(?:fixture|begin|initial|takeover-delay|takeover-alarm|successor|second-drain|release-old|release-new|coalesce|close)","event":"aborted","stateSeen":(?:true|false),"lastRunning":(?:true|false),"lastArmPending":(?:true|false),"lastSuccessor":(?:true|false),"lastSecondDrain":(?:true|false),"lastRowsBounded":(?:true|false)\}$/.test(
      line,
    ) ||
    readinessDiagnostic(line) ||
    publicationDiagnostic(line) ||
    liveRecoveryDiagnostic(line) ||
    nativeRecoveryDiagnostic(line) ||
    nativeObservationDiagnostic(line) ||
    /^# \{"diagnostic":"source-reentry-failure","phase":"(?:listen|fetch-once|fetch-twice|close|close-harness|close-directory|unknown)","kind":"(?:timeout|abort|assertion|directory-not-empty|resource-busy|permission|file-limit|other)","elapsedMs":(?:0|[1-9]\d{0,3}|[1-5]\d{4}|60000)\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-fixed-wake-failure","lastPhase":"(?:prepare|listen|environment|begin|hold-idle|sleep-successor|observe-successor|release-old|settle-old|check-wake)"\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-pi-wake-failure","phase":"(?:prepare|observe-failure|recover|observe-replacement|check-replacement|settle-old|check-old|observe-terminal|check-terminal)"\}$/.test(
      line,
    ) ||
    recoveryDiagnostic(line) ||
    roleDiagnostic(line) ||
    kernelDiagnostic(line) ||
    profileDiagnostic(line) ||
    recoveryStartFailureDiagnostic(line) ||
    (/^# \{"diagnostic":"source-recovery-process","sourcePath":(?:null|"(?:packages\/fortipi-[a-z]+\/test|apps\/worker\/test|scripts\/test\/release|tests\/clients)\/[A-Za-z0-9._/-]+\.(?:test|spec)\.ts"),"harnessOrdinal":\d{1,6},"invocation":\d{1,3},"runtimeCount":(?:null|\d{1,4}),"runnableCount":(?:null|\d{1,4}),"rssKiB":(?:null|\d{1,14}),"cpuMs":(?:null|\d{1,14})\}$/.test(
      line,
    ) &&
      !line.includes("../")) ||
    (/^# \{"diagnostic":"source-recovery-start","event":"(?:spawned|probe|ready|end)","invocation":\d{1,3},"elapsedMs":\d{1,8},"attempts":\d{1,3},"deadlines":\d{1,3},"transports":\d{1,3},"status":(?:null|[1-5]\d{2}),"exitCode":(?:null|-?\d{1,3}),"signal":(?:null|"(?:SIG[A-Z0-9]{1,8}|other)"),"logStage":"(?:ready-log|starting-log|unobserved)"(?:,"sourcePath":(?:null|"(?:packages\/fortipi-[a-z]+\/test|apps\/worker\/test|scripts\/test\/release|tests\/clients)\/[A-Za-z0-9._/-]+\.(?:test|spec)\.ts"),"harnessOrdinal":\d{1,6},"announcedPortMatches":(?:true|false|null))?\}$/.test(
      line,
    ) &&
      !line.includes("../")) ||
    /^# \{"diagnostic":"source-recovery-phase","event":"(?:enter|abort)","phase":"(?:initial\.start|agent\.create|canary\.(?:write|crash|restart|read)|allocation\.(?:initial|arm|wait|crash|lost|restart|retry)|(?:before-submit|after-submit)\.(?:arm|wait|crash|lost|restart|witness|retry|complete|inspect|repeat)|cleanup)","elapsedMs":\d{1,8},"phaseMs":\d{1,8}\}$/.test(
      line,
    )
  );
}

const applicationStates = new Set([
  "created",
  "awaiting_approval",
  "authorized",
  "queued",
  "waiting_for_executor",
  "waiting_for_local_policy",
  "leased",
  "dispatch_attempted",
  "running",
  "result_pending_commit",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "expired",
  "workspace_conflict",
  "requires_reconciliation",
]);
const ledgerStates = new Set(["pending", "start_intent", "running", "result", "closed", "unknown"]);

/** Fixed states and booleans only; never forward the assertion's private payload. */
export function nativeRecoveryFailureLine(
  applicationState: unknown,
  ledgerState: unknown,
  committed: boolean,
  connected: boolean,
): string {
  return JSON.stringify({
    diagnostic: "source-native-recovery-failure",
    applicationState:
      typeof applicationState === "string" && applicationStates.has(applicationState)
        ? applicationState
        : null,
    ledgerState:
      typeof ledgerState === "string" && ledgerStates.has(ledgerState) ? ledgerState : null,
    committed: committed === true,
    connected: connected === true,
  });
}

const nativeModes = new Set([
  "running",
  "seed",
  "attached",
  "attempted",
  "assign-ack",
  "result",
  "receipt",
]);
const nativeActivations = new Set(["agent-first", "executor-first"]);
const nativeQueryStates = new Set([
  "unknown",
  "not_started",
  "lost",
  "waiting_for_local_policy",
  "preparing",
  "running",
  "pending_sync",
  "terminal",
]);
const nativeResultStates = new Set(["succeeded", "failed", "cancelled", "unknown"]);
function ownDiagnosticField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}
function diagnosticEnum(value: unknown, values: Set<string>): string | null {
  return typeof value === "string" && values.has(value) ? value : null;
}
function diagnosticBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function diagnosticInteger(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}
function closedObservation(
  line: string,
  diagnostic: string,
  keys: string,
): Record<string, unknown> | null {
  if (!line.startsWith(`# {"diagnostic":"${diagnostic}",`)) return null;
  try {
    const r = JSON.parse(line.slice(2));
    return r &&
      typeof r === "object" &&
      !Array.isArray(r) &&
      Object.keys(r).join(",") === `diagnostic,${keys}` &&
      line === `# ${JSON.stringify(r)}`
      ? r
      : null;
  } catch {
    return null;
  }
}
function recoveryStartFailureDiagnostic(line: string): boolean {
  const r = closedObservation(
    line,
    "source-recovery-start-failure",
    "sourcePath,harnessOrdinal,invocation,marker,exitCode,signal",
  );
  return !!(
    r &&
    (r.sourcePath === null ||
      (typeof r.sourcePath === "string" &&
        testPath.test(r.sourcePath) &&
        !r.sourcePath.includes("../"))) &&
    typeof r.harnessOrdinal === "number" &&
    r.harnessOrdinal > 0 &&
    diagnosticInteger(r.harnessOrdinal, 999999) === r.harnessOrdinal &&
    typeof r.invocation === "number" &&
    r.invocation > 0 &&
    diagnosticInteger(r.invocation, 999) === r.invocation &&
    typeof r.marker === "string" &&
    /^(?:address-in-use|module-unavailable|memory|permission|filesystem|build-service|runtime|unknown)$/.test(
      r.marker,
    ) &&
    (r.exitCode === null ||
      (typeof r.exitCode === "number" &&
        Number.isInteger(r.exitCode) &&
        Math.abs(r.exitCode) <= 255)) &&
    (r.signal === null ||
      (typeof r.signal === "string" && /^(?:SIG[A-Z0-9]{1,8}|other)$/.test(r.signal)))
  );
}
function readinessDiagnostic(line: string): boolean {
  const r = closedObservation(
    line,
    "admission-runtime-readiness",
    "event,invocation,elapsedMs,attempts,fetchFailures,lastStatus,spawnError,childAlive",
  );
  return !!(
    r &&
    typeof r.event === "string" &&
    ["enter", "ready", "failed"].includes(r.event) &&
    diagnosticInteger(r.invocation, 999) === r.invocation &&
    Number(r.invocation) > 0 &&
    typeof r.elapsedMs === "number" &&
    diagnosticInteger(r.elapsedMs, 1_000_000) === r.elapsedMs &&
    typeof r.attempts === "number" &&
    diagnosticInteger(r.attempts, 999999) === r.attempts &&
    typeof r.fetchFailures === "number" &&
    diagnosticInteger(r.fetchFailures, 999999) === r.fetchFailures &&
    Number(r.fetchFailures) <= Number(r.attempts) &&
    (r.lastStatus === null ||
      (diagnosticInteger(r.lastStatus, 599) === r.lastStatus && Number(r.lastStatus) >= 100)) &&
    typeof r.spawnError === "boolean" &&
    typeof r.childAlive === "boolean"
  );
}
const localCodes = new Set([
  "conflict",
  "workspace.conflict",
  "unavailable",
  "unavailable_executor",
  "interrupted",
  "unauthorized",
  "unauthenticated",
  "not_found",
  "quota_paused",
  "invalid_request",
]);
const publicationReasons = new Set(["expired_lease", "stale_fence", "expected_revision"]);
function optionalEnum(value: unknown, values: Set<string>): boolean {
  return value === null || (typeof value === "string" && values.has(value));
}
function observedTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function expiredAt(expiry: unknown, at: unknown): boolean | null {
  return observedTime(expiry) && observedTime(at) ? expiry <= at : null;
}
/** Already-collected local observation only; request/original lease flags are not current authority. */
export function nativePublicationObservationLine(
  mode: unknown,
  activation: unknown,
  control: unknown,
  agent: unknown,
  timing: unknown,
): string {
  const local = ownDiagnosticField(control, "local");
  const length = diagnosticInteger(ownDiagnosticField(local, "length"), 8);
  let observe: unknown;
  if (Array.isArray(local) && length !== null)
    for (let i = 0; i < length; i++) {
      const row = ownDiagnosticField(local, String(i));
      if (ownDiagnosticField(row, "kind") === "observe") observe = row;
    }
  const began = ownDiagnosticField(observe, "startedAt"),
    finished = ownDiagnosticField(observe, "finishedAt"),
    reconnect = ownDiagnosticField(timing, "reconnectStartedAt"),
    at = ownDiagnosticField(timing, "observedAt");
  return JSON.stringify({
    diagnostic: "source-native-publication-observation",
    mode: diagnosticEnum(mode, nativeModes),
    activation: diagnosticEnum(activation, nativeActivations),
    observeOk: diagnosticBoolean(ownDiagnosticField(observe, "ok")),
    observeCode: diagnosticEnum(ownDiagnosticField(observe, "code"), localCodes),
    observeReason: diagnosticEnum(ownDiagnosticField(observe, "reason"), publicationReasons),
    observeSockets: diagnosticInteger(ownDiagnosticField(observe, "sockets"), 999),
    observeMs:
      observedTime(began) && observedTime(finished)
        ? diagnosticInteger(finished - began, 60000)
        : null,
    leaseExpiredAtObserve: expiredAt(ownDiagnosticField(observe, "leaseExpiresAt"), finished),
    observeBeforeReconnect:
      observedTime(finished) && observedTime(reconnect) ? finished <= reconnect : null,
    assignmentLeaseExpired: expiredAt(ownDiagnosticField(timing, "assignmentLeaseExpiresAt"), at),
    deadlineExpired: expiredAt(ownDiagnosticField(timing, "deadline"), at),
    pressureCode: diagnosticEnum(
      ownDiagnosticField(ownDiagnosticField(agent, "pressure"), "code"),
      localCodes,
    ),
  });
}
function publicationDiagnostic(line: string): boolean {
  const r = closedObservation(
    line,
    "source-native-publication-observation",
    "mode,activation,observeOk,observeCode,observeReason,observeSockets,observeMs,leaseExpiredAtObserve,observeBeforeReconnect,assignmentLeaseExpired,deadlineExpired,pressureCode",
  );
  return !!(
    r &&
    optionalEnum(r.mode, nativeModes) &&
    optionalEnum(r.activation, nativeActivations) &&
    [r.observeCode, r.pressureCode].every((v) => optionalEnum(v, localCodes)) &&
    optionalEnum(r.observeReason, publicationReasons) &&
    (r.observeSockets === null || diagnosticInteger(r.observeSockets, 999) === r.observeSockets) &&
    (r.observeMs === null || diagnosticInteger(r.observeMs, 60000) === r.observeMs) &&
    [
      r.observeOk,
      r.leaseExpiredAtObserve,
      r.observeBeforeReconnect,
      r.assignmentLeaseExpired,
      r.deadlineExpired,
    ].every((v) => v === null || typeof v === "boolean")
  );
}
export type LiveRecoveryPhase =
  | "packing"
  | "sbom"
  | "prepare"
  | "fixture"
  | "consumer"
  | "setup"
  | "setup-wrangler-import"
  | "setup-wrangler-mock"
  | "setup-installation"
  | "setup-deployment"
  | "setup-integrated-files"
  | "setup-integrated-inventory"
  | "setup-integrated-archive"
  | "setup-proof-index"
  | "setup-prepare-mock"
  | "setup-reader-import"
  | "setup-reader-mock"
  | "setup-selection-import"
  | "setup-selection-mock"
  | "setup-outer-import"
  | "guard-frame"
  | "guard-authority"
  | "guard-installed"
  | "guard-selection"
  | "outer-perform"
  | "perform"
  | "readonly"
  | "cleanup";
export type LiveRecoveryInvocation = "positive" | "tamper" | "omitted";
export type LiveRecoveryAwait = "outer" | "original-reader" | "cached-bridge" | "post-child";
const livePhases = new Set([
  "packing",
  "sbom",
  "prepare",
  "fixture",
  "consumer",
  "setup",
  "setup-wrangler-import",
  "setup-wrangler-mock",
  "setup-installation",
  "setup-deployment",
  "setup-integrated-files",
  "setup-integrated-inventory",
  "setup-integrated-archive",
  "setup-proof-index",
  "setup-prepare-mock",
  "setup-reader-import",
  "setup-reader-mock",
  "setup-selection-import",
  "setup-selection-mock",
  "setup-outer-import",
  "guard-frame",
  "guard-authority",
  "guard-installed",
  "guard-selection",
  "outer-perform",
  "perform",
  "readonly",
  "cleanup",
]);
const liveEvents = new Set(["enter", "caught"]);
const liveInvocations = new Set(["positive", "tamper", "omitted"]);
const liveAwaits = new Set(["outer", "original-reader", "cached-bridge", "post-child"]);
const liveAwaitEvents = new Set(["enter", "exit"]);
const childCodes = new Set([
  "ERR_ASSERTION",
  "ERR_TEST_FAILURE",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  "ENOENT",
  "EACCES",
  "ETIMEDOUT",
  "ABORT_ERR",
]);
const childSignals = new Set([
  "SIGTERM",
  "SIGKILL",
  "SIGABRT",
  "SIGINT",
  "SIGSEGV",
  "SIGBUS",
  "SIGILL",
  "SIGHUP",
  "SIGQUIT",
  "SIGPIPE",
  "SIGTRAP",
  "SIGSYS",
  "SIGXCPU",
  "SIGXFSZ",
]);
export function liveRecoveryPhaseLine(phase: unknown, event: unknown): string {
  return JSON.stringify({
    diagnostic: "source-live-recovery-phase",
    phase: diagnosticEnum(phase, livePhases),
    event: diagnosticEnum(event, liveEvents),
  });
}
function livePhase(line: string): Record<string, unknown> | null {
  const r = closedObservation(line, "source-live-recovery-phase", "phase,event");
  return r &&
    typeof r.phase === "string" &&
    livePhases.has(r.phase) &&
    typeof r.event === "string" &&
    liveEvents.has(r.event)
    ? r
    : null;
}
export function liveRecoveryAwaitLine(invocation: unknown, step: unknown, event: unknown): string {
  return JSON.stringify({
    diagnostic: "source-live-recovery-await",
    invocation: diagnosticEnum(invocation, liveInvocations),
    step: diagnosticEnum(step, liveAwaits),
    event: diagnosticEnum(event, liveAwaitEvents),
  });
}
function liveAwait(line: string): Record<string, unknown> | null {
  const r = closedObservation(line, "source-live-recovery-await", "invocation,step,event");
  return r &&
    typeof r.invocation === "string" &&
    liveInvocations.has(r.invocation) &&
    typeof r.step === "string" &&
    liveAwaits.has(r.step) &&
    typeof r.event === "string" &&
    liveAwaitEvents.has(r.event)
    ? r
    : null;
}
/** Inspect only bounded canonical markers in captured stdout; never forward child output/errors. */
export function liveRecoveryFailureLine(error: unknown): string {
  const stdout = ownDiagnosticField(error, "stdout");
  let lastPhase: unknown = null,
    lastPhaseAtError: unknown = null,
    lastInvocation: unknown = null,
    lastAwaitEntered: unknown = null,
    lastAwaitExited: unknown = null;
  if (typeof stdout === "string" && stdout.length <= 2_000_000) {
    const tail = stdout.slice(-8192),
      lines = tail.split("\n");
    if (stdout.length > tail.length) lines.shift();
    for (const line of lines.slice(-64)) {
      const r = line.length <= 160 ? livePhase(`# ${line}`) : null;
      if (r) {
        if (r.event === "enter") lastPhase = r.phase;
        else lastPhaseAtError = r.phase;
      }
      const awaited = line.length <= 160 ? liveAwait(`# ${line}`) : null;
      if (!awaited) continue;
      if (awaited.event === "enter") {
        if (awaited.invocation !== lastInvocation || awaited.step === "outer") {
          lastAwaitEntered = null;
          lastAwaitExited = null;
        }
        lastInvocation = awaited.invocation;
        lastAwaitEntered = awaited.step;
      } else if (awaited.invocation === lastInvocation) lastAwaitExited = awaited.step;
    }
  }
  const code = ownDiagnosticField(error, "code");
  return JSON.stringify({
    diagnostic: "source-live-recovery-failure",
    code:
      typeof code === "number" && Number.isInteger(code) && Math.abs(code) <= 255
        ? code
        : diagnosticEnum(code, childCodes),
    killed: diagnosticBoolean(ownDiagnosticField(error, "killed")),
    signal: diagnosticEnum(ownDiagnosticField(error, "signal"), childSignals),
    lastPhase,
    lastPhaseAtError,
    lastInvocation,
    lastAwaitEntered,
    lastAwaitExited,
  });
}
function liveRecoveryDiagnostic(line: string): boolean {
  if (livePhase(line) || liveAwait(line)) return true;
  const r = closedObservation(
    line,
    "source-live-recovery-failure",
    "code,killed,signal,lastPhase,lastPhaseAtError,lastInvocation,lastAwaitEntered,lastAwaitExited",
  );
  return !!(
    r &&
    (r.code === null ||
      (typeof r.code === "number" && Number.isInteger(r.code) && Math.abs(r.code) <= 255) ||
      (typeof r.code === "string" && childCodes.has(r.code))) &&
    (r.killed === null || typeof r.killed === "boolean") &&
    optionalEnum(r.signal, childSignals) &&
    [r.lastPhase, r.lastPhaseAtError].every((v) => optionalEnum(v, livePhases)) &&
    optionalEnum(r.lastInvocation, liveInvocations) &&
    [r.lastAwaitEntered, r.lastAwaitExited].every((v) => optionalEnum(v, liveAwaits))
  );
}
/** Project facts already collected by the fixture; never include its private trace. */
export function nativeRecoveryObservationLine(
  mode: unknown,
  activation: unknown,
  control: unknown,
  nativeResult: unknown,
  agent: unknown,
): string {
  const query = ownDiagnosticField(control, "query");
  const ok = ownDiagnosticField(query, "ok");
  const started = ownDiagnosticField(query, "startedAt"),
    finished = ownDiagnosticField(query, "finishedAt");
  return JSON.stringify({
    diagnostic: "source-native-recovery-observation",
    mode: diagnosticEnum(mode, nativeModes),
    activation: diagnosticEnum(activation, nativeActivations),
    queryState:
      ok === false
        ? "error"
        : ok === true
          ? diagnosticEnum(ownDiagnosticField(query, "state"), nativeQueryStates)
          : null,
    querySockets: diagnosticInteger(ownDiagnosticField(query, "sockets"), 999),
    queryAttempted: diagnosticBoolean(ownDiagnosticField(query, "attempted")),
    queryMs:
      typeof started === "number" && typeof finished === "number"
        ? diagnosticInteger(finished - started, 60000)
        : null,
    nativeResult: diagnosticEnum(nativeResult, nativeResultStates),
    receiptRetained: diagnosticBoolean(ownDiagnosticField(agent, "receiptRetained")),
    receiptAck: diagnosticBoolean(ownDiagnosticField(agent, "nativeReceiptAck")),
  });
}
function nativeObservationDiagnostic(line: string): boolean {
  if (!line.startsWith('# {"diagnostic":"source-native-recovery-observation",')) return false;
  try {
    const r = JSON.parse(line.slice(2));
    return (
      r !== null &&
      typeof r === "object" &&
      !Array.isArray(r) &&
      Object.keys(r).join(",") ===
        "diagnostic,mode,activation,queryState,querySockets,queryAttempted,queryMs,nativeResult,receiptRetained,receiptAck" &&
      line === `# ${JSON.stringify(r)}` &&
      (r.mode === null || nativeModes.has(r.mode)) &&
      (r.activation === null || nativeActivations.has(r.activation)) &&
      (r.queryState === null || r.queryState === "error" || nativeQueryStates.has(r.queryState)) &&
      (r.querySockets === null || diagnosticInteger(r.querySockets, 999) === r.querySockets) &&
      (r.queryMs === null || diagnosticInteger(r.queryMs, 60000) === r.queryMs) &&
      (r.nativeResult === null || nativeResultStates.has(r.nativeResult)) &&
      [r.queryAttempted, r.receiptRetained, r.receiptAck].every(
        (v) => v === null || typeof v === "boolean",
      )
    );
  } catch {
    return false;
  }
}

function nativeRecoveryDiagnostic(line: string): boolean {
  if (!line.startsWith('# {"diagnostic":"source-native-recovery-failure",')) return false;
  try {
    const record = JSON.parse(line.slice(2));
    return (
      record !== null &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      Object.keys(record).join(",") ===
        "diagnostic,applicationState,ledgerState,committed,connected" &&
      line === `# ${JSON.stringify(record)}` &&
      (record.applicationState === null || applicationStates.has(record.applicationState)) &&
      (record.ledgerState === null || ledgerStates.has(record.ledgerState)) &&
      typeof record.committed === "boolean" &&
      typeof record.connected === "boolean"
    );
  } catch {
    return false;
  }
}

/** Closed projection only; a caller must still validate before emitting. */
export function sourceKernelLine(
  data: KernelObservation,
  sourcePath: string | null,
  harnessOrdinal: number,
  invocation: number,
): string {
  return JSON.stringify({
    diagnostic: "source-recovery-kernel",
    sourcePath: sourcePath !== null && sourcePath.length <= 64 ? sourcePath : null,
    harnessOrdinal,
    invocation,
    status: data.status,
    stage: data.stage,
    elapsedMs: data.elapsedMs,
    roles: data.roles,
  });
}

function kernelDiagnostic(line: string): boolean {
  if (!line.startsWith('# {"diagnostic":"source-recovery-kernel",')) return false;
  try {
    const record: unknown = JSON.parse(line.slice(2));
    const closed = (value: unknown, keys: string): value is Record<string, unknown> =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).join(",") === keys;
    const integer = (value: unknown, low: number, high: number) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high;
    if (
      !closed(
        record,
        "diagnostic,sourcePath,harnessOrdinal,invocation,status,stage,elapsedMs,roles",
      ) ||
      line !== `# ${JSON.stringify(record)}` ||
      (record.sourcePath !== null &&
        (typeof record.sourcePath !== "string" ||
          record.sourcePath.length > 64 ||
          !testPath.test(record.sourcePath) ||
          record.sourcePath
            .split("/")
            .some((part) => part === ".." || part === "." || part === ""))) ||
      !integer(record.harnessOrdinal, 1, 999999) ||
      !integer(record.invocation, 1, 999)
    )
      return false;
    if (record.status === "unavailable")
      return (
        record.roles === null &&
        record.elapsedMs === null &&
        [
          "unsupported",
          "owner",
          "executable",
          "lineage",
          "socket",
          "identity",
          "bounds",
          "counters",
          "wchan",
        ].includes(record.stage as string)
      );
    return (
      record.status === "available" &&
      record.stage === "complete" &&
      integer(record.elapsedMs, 500, 5000) &&
      Array.isArray(record.roles) &&
      record.roles.length === 2 &&
      record.roles.every(
        (row, index) =>
          closed(row, "role,userTicks,systemTicks,majorFaults,wait") &&
          row.role === ["proxy", "user"][index] &&
          integer(row.userTicks, 0, 1000000) &&
          integer(row.systemTicks, 0, 1000000) &&
          integer(row.majorFaults, 0, 1000000) &&
          Array.isArray(row.wait) &&
          row.wait.length === 2 &&
          row.wait.every((value) =>
            [
              "futex",
              "event",
              "io",
              "page",
              "writeback",
              "reclaim",
              "schedule",
              "timer",
              "other",
              "zero",
              "unavailable",
            ].includes(value),
          ),
      )
    );
  } catch {
    return false;
  }
}

/** Failure-only owned runtime facts, never native frames or private socket output. */
function roleDiagnostic(line: string): boolean {
  if (!line.startsWith('# {"diagnostic":"source-recovery-role",')) return false;
  try {
    const record: unknown = JSON.parse(line.slice(2));
    const closed = (value: unknown, keys: string): value is Record<string, unknown> =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).join(",") === keys;
    const integer = (value: unknown, low: number, high: number): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high;
    if (
      !closed(
        record,
        "diagnostic,sourcePath,harnessOrdinal,invocation,status,stage,elapsedMs,roles",
      ) ||
      line !== `# ${JSON.stringify(record)}` ||
      (record.sourcePath !== null &&
        (typeof record.sourcePath !== "string" ||
          record.sourcePath.length > 64 ||
          !testPath.test(record.sourcePath) ||
          record.sourcePath
            .split("/")
            .some((part) => part === ".." || part === "." || part === ""))) ||
      !integer(record.harnessOrdinal, 1, 999999) ||
      !integer(record.invocation, 1, 999)
    )
      return false;
    if (record.status === "unavailable")
      return (
        record.roles === null &&
        record.elapsedMs === null &&
        ["unsupported", "owner", "executable", "lineage", "socket", "identity", "bounds"].includes(
          record.stage as string,
        )
      );
    return (
      record.status === "available" &&
      record.stage === "complete" &&
      integer(record.elapsedMs, 500, 5000) &&
      Array.isArray(record.roles) &&
      record.roles.length === 2 &&
      record.roles.every(
        (row, index) =>
          closed(row, "role,ticks,state") &&
          row.role === ["proxy", "user"][index] &&
          integer(row.ticks, 0, 1000000) &&
          ["R", "S", "D", "T", "t", "I", "W", "P"].includes(row.state as string),
      )
    );
  } catch {
    return false;
  }
}

/** One closed summary plus at most five ranked frames; each stays within512 bytes. */
function profileDiagnostic(line: string): boolean {
  if (!line.startsWith('# {"diagnostic":"source-recovery-profile",')) return false;
  try {
    const value: unknown = JSON.parse(line.slice(2));
    const closed = (input: unknown, keys: string): input is Record<string, unknown> =>
      input !== null &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      Object.keys(input).join(",") === keys;
    const integer = (input: unknown, low: number, high: number): input is number =>
      typeof input === "number" && Number.isSafeInteger(input) && input >= low && input <= high;
    const hash = (input: unknown) => typeof input === "string" && /^[a-f0-9]{64}$/.test(input);
    const identity = "diagnostic,sourcePath,harnessOrdinal,invocation";
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      line !== `# ${JSON.stringify(value)}`
    )
      return false;
    const record = value as Record<string, unknown>;
    if (
      (record.sourcePath !== null &&
        (typeof record.sourcePath !== "string" ||
          record.sourcePath.length > 64 ||
          !testPath.test(record.sourcePath) ||
          record.sourcePath.split("/").includes(".."))) ||
      !integer(record.harnessOrdinal, 1, 999999) ||
      !integer(record.invocation, 1, 999)
    )
      return false;
    if (
      Object.keys(record).join(",") ===
      `${identity},profileSha256,rank,functionSha256,urlSha256,line,column,samples`
    )
      return (
        hash(record.profileSha256) &&
        integer(record.rank, 0, 4) &&
        hash(record.functionSha256) &&
        hash(record.urlSha256) &&
        integer(record.line, -1, 9999999) &&
        integer(record.column, -1, 9999999) &&
        integer(record.samples, 1, 100000)
      );
    if (
      Object.keys(record).join(",") !== `${identity},status,stage,methods,profile` ||
      !Array.isArray(record.methods) ||
      record.methods.length !== 4
    )
      return false;
    const methods = ["Profiler.enable", "Profiler.start", "Profiler.stop", "Profiler.disable"];
    if (
      !record.methods.every(
        (entry: unknown, index: number) =>
          Array.isArray(entry) &&
          entry.length === 3 &&
          entry[0] === methods[index] &&
          ["not-sent", "ok", "cdp-error", "timeout", "transport"].includes(entry[1]) &&
          (entry[2] === null || (entry[1] === "cdp-error" && integer(entry[2], -32768, 32767))),
      )
    )
      return false;
    if (record.status === "unavailable")
      return (
        record.profile === null &&
        ["discovery", "connect", "cdp", "profile"].includes(record.stage as string)
      );
    const profile = record.profile;
    return (
      record.status === "available" &&
      record.stage === "complete" &&
      record.methods.slice(0, 3).every((entry) => entry[1] === "ok") &&
      closed(profile, "bytes,sha256,nodes,samples,durationUs") &&
      integer(profile.bytes, 1, 2097152) &&
      hash(profile.sha256) &&
      integer(profile.nodes, 1, 30000) &&
      integer(profile.samples, 0, 100000) &&
      integer(profile.durationUs, 0, 5000000)
    );
  } catch {
    return false;
  }
}

/** Exact process-recovery fixture output only, never an arbitrary TAP diagnostic. */
function recoveryDiagnostic(line: string): boolean {
  if (!line.startsWith("# ")) return false;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(2));
  } catch {
    return false;
  }
  const closed = (input: unknown, keys: string): input is Record<string, unknown> =>
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).join(",") === keys;
  // Echo original bytes only when they are exactly the producer's serialization.
  // Otherwise duplicate keys could conceal a private value discarded by JSON.parse.
  if (!closed(value, "phase,kind,code,location,request") || line !== `# ${JSON.stringify(value)}`)
    return false;
  const code = (input: unknown, allowed: string[]) =>
    input === null || (typeof input === "string" && allowed.includes(input));
  if (
    typeof value.phase !== "string" ||
    !/^(?:initial\.start|agent\.create|canary\.(?:write|crash|restart|read)|allocation\.(?:initial|arm|wait|crash|lost|restart|retry)|(?:before-submit|after-submit)\.(?:arm|wait|crash|lost|restart|witness|retry|complete|inspect|repeat)|cleanup)$/.test(
      value.phase,
    ) ||
    typeof value.kind !== "string" ||
    !["unknown", "assertion", "error", "non-error"].includes(value.kind) ||
    !code(value.code, [
      "ERR_ASSERTION",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ABORT_ERR",
      "ERR_TEST_FAILURE",
    ]) ||
    (value.location !== null &&
      (typeof value.location !== "string" ||
        !/^(?:process-(?:recovery\.test|harness)|harness)\.ts:\d{1,6}:\d{1,6}$/.test(
          value.location,
        )))
  )
    return false;
  const request = value.request;
  return (
    request === null ||
    (closed(request, "operation,stage,reason,code,childExitCode,childSignal") &&
      typeof request.operation === "string" &&
      ["state", "barrier", "submission", "other"].includes(request.operation) &&
      typeof request.stage === "string" &&
      ["response", "body"].includes(request.stage) &&
      typeof request.reason === "string" &&
      ["deadline", "transport", "body"].includes(request.reason) &&
      code(request.code, [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ]) &&
      (request.childExitCode === null ||
        (typeof request.childExitCode === "number" &&
          Number.isInteger(request.childExitCode) &&
          Math.abs(request.childExitCode) <= 255)) &&
      (request.childSignal === null ||
        request.childSignal === "SIGKILL" ||
        request.childSignal === "SIGTERM"))
  );
}
