import { ChildProcess, spawnSync } from "node:child_process";
import { subscribe } from "node:diagnostics_channel";
import { lstatSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testPath =
  /^(?:packages\/fortipi-[a-z]+\/test|apps\/worker\/test|scripts\/test\/release|tests\/clients)\/[A-Za-z0-9._/-]+\.(?:test|spec)\.ts$/;
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
const failureNames = new Set<string>([
  "SIGKILL/reopen preserves canary, allocation provenance and stable accepted input",
  "premature cues from held or rejected marker transactions cannot become historical proof",
  "kill cues match only the exact run, agent, phase, arm and actor generation; no storage proof",
  "ticket-only consume is atomic and binds audience, destination, Origin and expiry",
  "actual failed HTTP upgrade spends a ticket; CORS admits only exact configured HTTPS origins",
  "integrated persistent runtime retains actual Pi input and repairs the same admission across both acknowledged SIGKILL boundaries",
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
  "apps/worker/test/agent/process-recovery.test.ts",
  "apps/worker/test/control/tickets.test.ts",
  "apps/worker/test/execution/native-connected-recovery.test.ts",
  "apps/worker/test/integration/admission-recovery.test.ts",
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
  "apps/worker/test/integration/oracles.ts",
  "apps/worker/test/integration/runtime.ts",
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
  let indent = 0,
    yaml = false,
    stack = false,
    stackLocation = false,
    records = 0;
  const flush = () => {
    if (pending && records++ < 1024) emit(`${JSON.stringify(pending)}\n`);
    pending = undefined;
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
        const location = field.startsWith("location:") || stack ? sourceLocation(line) : null;
        if (location && !stackLocation) {
          pending.location = location;
          stackLocation = stack;
        }
      }
    }
  };
}

/** Failure-only Linux observation of this fixture's existing detached process group. */
export function observeSourceProcessCompute(
  group: number,
  phase: "readiness-end" | "request-deadline",
): void {
  if (
    process.env.FORTIPI_SOURCE_PI_OPEN_DIAGNOSTICS !== "1" ||
    process.platform !== "linux" ||
    !Number.isSafeInteger(group) ||
    group <= 0
  )
    return;
  try {
    const result = spawnSync("ps", ["-eo", "pgid=,comm=,pcpu="], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 1_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let processes = 0,
      workerd = 0,
      workerdCentiCpu: number | null = null,
      nodeCentiCpu: number | null = null;
    if (result.status === 0 && !result.error)
      for (const row of result.stdout.split(/\r?\n/)) {
        const match = /^\s*(\d{1,12})\s+(\S{1,4096})\s+(\d{1,5}(?:\.\d{1,3})?)\s*$/.exec(row);
        if (!match || Number(match[1]) !== group) continue;
        processes = Math.min(999, processes + 1);
        const cpu = Math.round(Number(match[3]) * 100);
        if (!Number.isSafeInteger(cpu) || cpu < 0 || cpu > 999999) continue;
        if (/(?:^|\/)workerd(?:\.exe)?$/.test(match[2]!)) {
          workerd = Math.min(999, workerd + 1);
          workerdCentiCpu = Math.max(workerdCentiCpu ?? 0, cpu);
        }
        if (/(?:^|\/)node(?:\.exe)?$/.test(match[2]!))
          nodeCentiCpu = Math.max(nodeCentiCpu ?? 0, cpu);
      }
    const line = JSON.stringify({
      diagnostic: "source-process-compute",
      phase,
      available: result.status === 0 && !result.error,
      processes,
      workerd,
      workerdCentiCpu,
      nodeCentiCpu,
    });
    if (sourceTestDiagnostic(`# ${line}`)) console.log(line);
  } catch {
    // Never expose process names, paths, raw output/errors or change the failure.
  }
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
    recoveryDiagnostic(line) ||
    /^# \{"diagnostic":"source-process-compute","phase":"(?:readiness-end|request-deadline)","available":(?:true|false),"processes":\d{1,3},"workerd":\d{1,3},"workerdCentiCpu":(?:null|\d{1,6}),"nodeCentiCpu":(?:null|\d{1,6})\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-native-ordering","mode":"(?:running|seed|attached|attempted|assign-ack|result|receipt)","queryBeforeReconnect":(?:true|false|null),"queryEpochMatchesSession":(?:true|false|null),"currentCPOnline":(?:true|false|null),"currentCPEpochMatchesSession":(?:true|false|null),"currentCPGenerationMatches":(?:true|false|null),"currentCPChannel":(?:true|false|null),"nativeConnected":(?:true|false),"sessionRegistered":(?:true|false)\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-pi-open-stage","invocation":\d{1,3},"stage":"(?:last-close|session-store|factory|root|resume|turn|wake)\.(?:enter|exit)"\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-native-query","mode":"(?:running|seed|attached|attempted|assign-ack|result|receipt)","ordinal":\d{1,4},"state":(?:null|"(?:preparing|not_started|running|pending_sync|terminal|lost|unknown)"),"error":(?:null|"(?:authority|other)"),"ledgerState":(?:null|"(?:pending|start_intent|running|result|closed|unknown)"),"child":"(?:alive|exited|absent)","active":(?:true|false),"incarnationMatches":(?:true|false),"leaseExpired":(?:true|false|null),"hasResult":(?:true|false)\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-native-control","mode":"(?:running|seed|attached|attempted|assign-ack|result|receipt)","queries":\d{1,4},"recorded":(?:true|false),"ok":(?:true|false|null),"state":(?:null|"(?:preparing|not_started|running|pending_sync|terminal|lost|unknown)"),"code":(?:null|"(?:unauthenticated|unauthorized|unavailable|unavailable_executor|conflict|expired|quota_paused|rate_limited|unsupported|invalid_request|not_found|internal)"),"attempted":(?:true|false|null),"reserved":(?:true|false|null),"result":(?:true|false|null),"late":(?:true|false|null),"socket":(?:true|false|null),"durationMs":(?:null|\d{1,8})\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-integration-phase","event":"(?:enter|error)","phase":"(?:initial\.start|agent\.create|canary\.(?:write|crash|restart|read)|(?:before-submit|after-submit)\.(?:arm|wait|inspect|crash|lost|restart|retry|complete|repeat)|cleanup)","kind":(?:null|"(?:request-deadline|boundary-timeout|other)"),"elapsedMs":\d{1,8}\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-runtime-startup","invocation":\d{1,3},"checkpoint":"(?:ready|readiness-end|request-failure)","stages":(?:\d|[1-9]\d|1\d{2}|2[0-4]\d|25[0-5])\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-runtime-readiness","invocation":\d{1,3},"fetchStatus":(?:null|[1-5]\d{2}),"httpStatus":(?:null|[1-5]\d{2}),"httpOutcome":"(?:response|deadline|transport)"\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-native-state","mode":"(?:running|seed|attached|attempted|assign-ack|result|receipt)","activation":"(?:agent-first|executor-first)","jobState":(?:null|"(?:created|awaiting_approval|authorized|queued|waiting_for_executor|waiting_for_local_policy|leased|dispatch_attempted|running|result_pending_commit|completed|failed|cancelled|interrupted|expired|workspace_conflict|requires_reconciliation)"),"ledgerState":(?:null|"(?:pending|start_intent|running|result|closed|unknown)"),"resultState":(?:null|"(?:succeeded|failed|cancelled|unknown)"),"committed":(?:true|false),"connected":(?:true|false)\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-recovery-start","event":"(?:spawned|probe|ready|end)","invocation":\d{1,3},"elapsedMs":\d{1,8},"attempts":\d{1,3},"deadlines":\d{1,3},"transports":\d{1,3},"status":(?:null|[1-5]\d{2}),"exitCode":(?:null|-?\d{1,3}),"signal":(?:null|"(?:SIG[A-Z0-9]{1,8}|other)"),"logStage":"(?:ready-log|starting-log|unobserved)"\}$/.test(
      line,
    ) ||
    /^# \{"diagnostic":"source-recovery-phase","event":"(?:enter|abort)","phase":"(?:initial\.start|agent\.create|canary\.(?:write|crash|restart|read)|allocation\.(?:initial|arm|wait|crash|lost|restart|retry)|(?:before-submit|after-submit)\.(?:arm|wait|crash|lost|restart|witness|retry|complete|inspect|repeat)|cleanup)","elapsedMs":\d{1,8},"phaseMs":\d{1,8}\}$/.test(
      line,
    )
  );
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
