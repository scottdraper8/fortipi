import { ChildProcess } from "node:child_process";
import { subscribe } from "node:diagnostics_channel";
import { lstatSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootSamples, bootStages } from "../apps/worker/test/agent/boot-trace.ts";
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
    recoveryDiagnostic(line) ||
    roleDiagnostic(line) ||
    kernelDiagnostic(line) ||
    bootDiagnostic(line) ||
    profileDiagnostic(line) ||
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

export function sourceBootLine(
  output: string,
  sourcePath: string | null,
  harnessOrdinal: number,
  invocation: number,
): string {
  const samples = bootSamples(output);
  return JSON.stringify({
    diagnostic: "source-recovery-boot",
    sourcePath: sourcePath !== null && sourcePath.length <= 64 ? sourcePath : null,
    harnessOrdinal,
    invocation,
    status: samples.length ? "observed" : "unavailable",
    samples,
  });
}

function bootDiagnostic(line: string): boolean {
  if (!line.startsWith('# {"diagnostic":"source-recovery-boot",')) return false;
  try {
    const r = JSON.parse(line.slice(2)) as Record<string, unknown>;
    if (
      !r ||
      typeof r !== "object" ||
      Array.isArray(r) ||
      Object.keys(r).join(",") !==
        "diagnostic,sourcePath,harnessOrdinal,invocation,status,samples" ||
      line !== `# ${JSON.stringify(r)}` ||
      (r.sourcePath !== null &&
        (typeof r.sourcePath !== "string" ||
          r.sourcePath.length > 64 ||
          !testPath.test(r.sourcePath) ||
          r.sourcePath.split("/").some((part) => part === ".." || part === "." || part === ""))) ||
      !Number.isInteger(r.harnessOrdinal) ||
      (r.harnessOrdinal as number) < 1 ||
      (r.harnessOrdinal as number) > 999999 ||
      !Number.isInteger(r.invocation) ||
      (r.invocation as number) < 1 ||
      (r.invocation as number) > 999 ||
      !Array.isArray(r.samples)
    )
      return false;
    if (r.status === "unavailable") return r.samples.length === 0;
    let previous = -1;
    return (
      r.status === "observed" &&
      r.samples.length > 0 &&
      r.samples.length <= bootStages.length &&
      r.samples.every((row: unknown) => {
        if (!Array.isArray(row) || row.length !== 2) return false;
        const index = bootStages.indexOf(row[0]),
          count = row[1];
        if (
          index <= previous ||
          !Number.isInteger(count) ||
          count < 1 ||
          count > 524288 ||
          (count & (count - 1)) !== 0
        )
          return false;
        previous = index;
        return true;
      })
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
