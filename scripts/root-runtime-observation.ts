// Temporary source diagnostics. No observation is an oracle or a cause inference.
import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";

const causes = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EADDRINUSE",
  "EACCES",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
] as const;
type Cause = (typeof causes)[number] | null;
type Phase = "start" | "stall" | "end";
type Kind = "process" | "integration";
const maximum = Number.MAX_SAFE_INTEGER;
const bounded = (value: unknown, min = 0, max = maximum): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max &&
  !Object.is(value, -0);
const numeric = (value: unknown, min = 0, max = maximum) =>
  value === null || bounded(value, min, max);
const member = (value: unknown, values: readonly string[]) =>
  typeof value === "string" && values.includes(value);
const keys = (value: Record<string, unknown>, names: string) =>
  Object.keys(value).join(",") === names;

/** Accept raw canonical JSON or exactly one TAP '# ' prefix; <=512 UTF-16 units total. */
export function rootRuntimeDiagnostic(line: string): boolean {
  if (typeof line !== "string" || line.length > 512) return false;
  const json = line.startsWith("# ") ? line.slice(2) : line;
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const r = value as Record<string, unknown>;
    if (
      json !== JSON.stringify(r) ||
      r.diagnostic !== "root-runtime-v1" ||
      !member(r.kind, ["process", "integration"]) ||
      !bounded(r.invocation, 1, 999) ||
      !member(r.phase, ["start", "stall", "end"]) ||
      !bounded(r.elapsedMs, 0, 99_999_999)
    )
      return false;
    const base = "diagnostic,kind,invocation,phase,elapsedMs,metric,";
    switch (r.metric) {
      case "readiness":
        return (
          keys(r, `${base}outcome,attempts,deadlines,transports,status,cause,readyPort`) &&
          member(r.outcome, ["waiting", "response", "deadline", "transport", "ready", "failed"]) &&
          bounded(r.attempts, 0, 999999) &&
          bounded(r.deadlines, 0, r.attempts) &&
          bounded(r.transports, 0, r.attempts) &&
          r.deadlines + r.transports <= r.attempts &&
          numeric(r.status, 100, 599) &&
          (r.cause === null || member(r.cause, causes)) &&
          member(r.readyPort, ["unknown", "match", "mismatch", "conflict"])
        );
      case "process":
        return (
          keys(
            r,
            `${base}wrapper,workerd,listener,wrapperExit,workerdExit,processes,rssKiB,groupProcesses,groupRssKiB,groupZombies,workers,workerZombies`,
          ) &&
          member(r.wrapper, ["live", "zombie", "absent", "unknown"]) &&
          member(r.workerd, ["live", "zombie", "mixed", "absent", "unknown"]) &&
          member(r.listener, ["expected-group", "foreign", "absent", "unknown"]) &&
          numeric(r.wrapperExit, -255, 255) &&
          r.workerdExit === null &&
          [r.processes, r.groupProcesses, r.groupZombies, r.workers, r.workerZombies].every((v) =>
            numeric(v, 0, 4096),
          ) &&
          numeric(r.rssKiB) &&
          numeric(r.groupRssKiB)
        );
      case "kernel":
        return (
          keys(
            r,
            `${base}cpuLimit,memoryLimit,quotaUs,periodUs,usageUs,periods,throttled,throttledUs,memoryBytes,memoryLimitBytes,oom,oomKill`,
          ) &&
          member(r.cpuLimit, ["limited", "unlimited", "unknown"]) &&
          member(r.memoryLimit, ["limited", "unlimited", "unknown"]) &&
          (r.cpuLimit === "limited" ? bounded(r.quotaUs, 1) : r.quotaUs === null) &&
          (r.cpuLimit === "unknown" ? r.periodUs === null : bounded(r.periodUs, 1)) &&
          (r.memoryLimit === "limited"
            ? bounded(r.memoryLimitBytes)
            : r.memoryLimitBytes === null) &&
          [
            r.quotaUs,
            r.periodUs,
            r.usageUs,
            r.periods,
            r.throttled,
            r.throttledUs,
            r.memoryBytes,
            r.memoryLimitBytes,
            r.oom,
            r.oomKill,
          ].every((v) => numeric(v))
        );
      case "delta":
        return (
          r.phase !== "start" &&
          keys(
            r,
            `${base}processes,rssKiB,groupProcesses,groupRssKiB,usageUs,periods,throttled,throttledUs,memoryBytes,oom,oomKill`,
          ) &&
          [r.processes, r.groupProcesses].every((v) => numeric(v, -4096, 4096)) &&
          [r.rssKiB, r.groupRssKiB, r.memoryBytes].every((v) => numeric(v, -maximum)) &&
          [r.usageUs, r.periods, r.throttled, r.throttledUs, r.oom, r.oomKill].every((v) =>
            numeric(v),
          )
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// Private input never escapes these functions. A truncated/malformed table is unavailable.
type Row = { pid: number; group: number; zombie: boolean; rss: number; worker: boolean };
function processRows(text: string): Row[] | null {
  const lines = text.trim().split("\n");
  if (!text.trim() || lines.length > 4096) return null;
  const rows: Row[] = [];
  for (const line of lines) {
    const m =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z+<?NslLWXZITtDPRSU0-9-]+)\s+(\d+)\s+(.+?)\s*$/.exec(
        line,
      );
    if (!m) return null;
    const pid = Number(m[1]),
      group = Number(m[3]),
      rss = Number(m[5]);
    if (!bounded(pid, 1) || !bounded(group) || !bounded(rss)) return null;
    rows.push({
      pid,
      group,
      zombie: m[4]?.startsWith("Z") === true,
      rss,
      worker: /(?:^|\/)workerd(?: \(deleted\))?$/.test(m[6] ?? ""),
    });
  }
  return rows;
}
function command(file: "ps" | "ss", args: string[], signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { encoding: "utf8", timeout: 650, maxBuffer: 262144, windowsHide: true, signal },
        (error, stdout) => resolve(error ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });
}
async function smallFile(path: string, limit = 8192): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > limit ? null : buffer.toString("utf8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    try {
      await handle?.close();
    } catch {
      /* unavailable */
    }
  }
}
const number = (text: string | undefined): number | null => {
  if (!text || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return bounded(value) ? value : null;
};
function counters(text: string | null): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of text?.trim().split("\n") ?? []) {
    const m = /^([a-z_]+) (\d+)$/.exec(line);
    if (m?.[1]) {
      const value = number(m[2]);
      if (value !== null && !result.has(m[1])) result.set(m[1], value);
      else return new Map();
    } else return new Map();
  }
  return result;
}
async function kernel() {
  const unknown = {
    cpuLimit: "unknown",
    memoryLimit: "unknown",
    quotaUs: null,
    periodUs: null,
    usageUs: null,
    periods: null,
    throttled: null,
    throttledUs: null,
    memoryBytes: null,
    memoryLimitBytes: null,
    oom: null,
    oomKill: null,
  };
  if (process.platform !== "linux") return unknown;
  const [membership, mounts] = await Promise.all([
    smallFile("/proc/self/cgroup"),
    smallFile("/proc/self/mountinfo", 32768),
  ]);
  const entries = membership?.split("\n").filter((line) => line.startsWith("0::"));
  const mount = mounts?.split("\n").filter((line) => line.includes(" - cgroup2 "));
  if (entries?.length !== 1 || mount?.length !== 1) return unknown;
  const path = entries[0]?.slice(3),
    fields = mount[0]?.split(" ");
  const root = fields?.[3],
    target = fields?.[4];
  // No guessed host path, escaped mounts or traversal. v1/ambiguous mounts stay unknown.
  if (
    !path?.startsWith("/") ||
    !root?.startsWith("/") ||
    !target?.startsWith("/") ||
    [path, root, target].some((s) => /[\\\0]/.test(s) || s.split("/").includes("..")) ||
    !(root === "/" || path === root || path.startsWith(`${root}/`))
  )
    return unknown;
  const directory = posix.join(target, posix.relative(root, path));
  const [max, stat, memory, limit, events] = await Promise.all(
    ["cpu.max", "cpu.stat", "memory.current", "memory.max", "memory.events"].map((name) =>
      smallFile(posix.join(directory, name)),
    ),
  );
  const cpu = counters(stat ?? null),
    mem = counters(events ?? null);
  const quota = /^(max|\d+) (\d+)\n?$/.exec(max ?? "");
  const period = number(quota?.[2]),
    finiteQuota = number(quota?.[1]);
  const cpuLimit =
    period !== null && period > 0 && quota?.[1] === "max"
      ? "unlimited"
      : period !== null && period > 0 && finiteQuota !== null && finiteQuota > 0
        ? "limited"
        : "unknown";
  const memoryLimitBytes = number(limit?.trim());
  return {
    cpuLimit,
    memoryLimit:
      memoryLimitBytes !== null ? "limited" : limit?.trim() === "max" ? "unlimited" : "unknown",
    quotaUs: cpuLimit === "limited" ? finiteQuota : null,
    periodUs: cpuLimit === "unknown" ? null : period,
    usageUs: cpu.get("usage_usec") ?? null,
    periods: cpu.get("nr_periods") ?? null,
    throttled: cpu.get("nr_throttled") ?? null,
    throttledUs: cpu.get("throttled_usec") ?? null,
    memoryBytes: number(memory?.trim()),
    memoryLimitBytes,
    oom: mem.get("oom") ?? null,
    oomKill: mem.get("oom_kill") ?? null,
  };
}
function listenerOwner(
  text: string | null,
  rows: Row[] | null,
  port: number,
  group: number | undefined,
) {
  if (text === null || !rows || !group) return "unknown";
  const lines = text.trim() ? text.trim().split("\n") : [];
  if (lines.length > 4096) return "unknown";
  let matched = false,
    expected = false,
    foreign = false,
    unknown = false;
  const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
  for (const line of lines) {
    // ss -H -ltnp: State Recv-Q Send-Q Local Peer [private owner metadata].
    const m = /^LISTEN\s+\d+\s+\d+\s+(\S+)\s+(\S+)(.*)$/.exec(line);
    if (!m) return "unknown";
    const endpoint = /:(\d+)$/.exec(m[1] ?? "");
    if (!endpoint || !bounded(Number(endpoint[1]), 1, 65535)) return "unknown";
    if (Number(endpoint[1]) !== port) continue;
    matched = true;
    const pids = [...(m[3] ?? "").matchAll(/\bpid=(\d+),/g)];
    if (!pids.length) unknown = true;
    for (const pid of pids) {
      const row = rowsByPid.get(Number(pid[1]));
      if (!row) unknown = true;
      else if (row.group === group) expected = true;
      else foreign = true;
    }
  }
  return !matched
    ? "absent"
    : unknown || (expected && foreign)
      ? "unknown"
      : foreign
        ? "foreign"
        : expected
          ? "expected-group"
          : "unknown";
}
async function sample(child: ChildProcess, port: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  timer.unref();
  try {
    const [ps, ss, resources] = await Promise.all([
      command("ps", ["-eo", "pid=,ppid=,pgid=,stat=,rss=,comm="], controller.signal),
      process.platform === "linux"
        ? command("ss", ["-H", "-ltnp"], controller.signal)
        : Promise.resolve(null),
      kernel(),
    ]);
    const rows = ps === null ? null : processRows(ps);
    const group = child.pid ? rows?.filter((row) => row.group === child.pid) : undefined,
      workers = group?.filter((row) => row.worker);
    const wrapper = rows?.find((row) => row.pid === child.pid);
    const sum = (items: Row[] | undefined | null) => {
      if (!items) return null;
      const value = items.reduce((total, row) => total + row.rss, 0);
      return bounded(value) ? value : null;
    };
    const zombies = workers?.filter((row) => row.zombie).length;
    return {
      processes: {
        wrapper:
          !rows || !child.pid
            ? "unknown"
            : !wrapper
              ? "absent"
              : wrapper.zombie
                ? "zombie"
                : "live",
        workerd: !workers
          ? "unknown"
          : !workers.length
            ? "absent"
            : !zombies
              ? "live"
              : zombies === workers.length
                ? "zombie"
                : "mixed",
        listener: listenerOwner(ss, rows, port, child.pid),
        wrapperExit: numeric(child.exitCode, -255, 255) ? child.exitCode : null,
        workerdExit: null,
        processes: rows?.length ?? null,
        rssKiB: sum(rows),
        groupProcesses: group?.length ?? null,
        groupRssKiB: sum(group),
        groupZombies: group?.filter((row) => row.zombie).length ?? null,
        workers: workers?.length ?? null,
        workerZombies: zombies ?? null,
      },
      resources,
    };
  } finally {
    clearTimeout(timer);
  }
}
type Snapshot = Awaited<ReturnType<typeof sample>>;

/** No timers/requests in readiness. All callbacks are guarded; sampling is side work. */
export function observeRootRuntime(options: {
  kind: Kind;
  invocation: number;
  child: ChildProcess;
  port: number;
  emit?: (line: string) => void;
}) {
  const noop = {
    response: (_status: number) => {},
    failure: (_error: unknown, _deadline: boolean) => {},
    finish: (_ready: boolean) => {},
  };
  if (
    process.env.FORTIPI_ROOT_CONTEXT_DIAGNOSTICS !== "1" ||
    !bounded(options.invocation, 1, 999) ||
    !bounded(options.port, 1, 65535)
  )
    return noop;
  try {
    const { child, port } = options;
    const began = performance.now();
    let attempts = 0,
      deadlines = 0,
      transports = 0,
      status: number | null = null,
      cause: Cause = null;
    let outcome = "waiting",
      readyPort = "unknown",
      finished = false,
      stalled = false,
      running = false;
    let rows = 0,
      bytes = 0,
      snapshots = 0;
    const queue: { phase: Phase; readiness: Record<string, unknown> }[] = [];
    let initial: Snapshot | undefined;
    const elapsed = () => Math.min(99_999_999, Math.max(0, Math.round(performance.now() - began)));
    const emit = (phase: Phase, metric: string, data: Record<string, unknown>) => {
      try {
        const line = JSON.stringify({
          diagnostic: "root-runtime-v1",
          kind: options.kind,
          invocation: options.invocation,
          phase,
          elapsedMs: elapsed(),
          metric,
          ...data,
        });
        const size = Buffer.byteLength(line) + 1;
        // Reserve two units for Node TAP's '# ' prefix.
        if (rows >= 11 || bytes + size > 5632 || line.length > 510 || !rootRuntimeDiagnostic(line))
          return;
        rows++;
        bytes += size;
        (options.emit ?? console.log)(line);
      } catch {
        /* Original result wins, including a throwing output callback. */
      }
    };
    const unknown: Snapshot = {
      processes: {
        wrapper: "unknown",
        workerd: "unknown",
        listener: "unknown",
        wrapperExit: null,
        workerdExit: null,
        processes: null,
        rssKiB: null,
        groupProcesses: null,
        groupRssKiB: null,
        groupZombies: null,
        workers: null,
        workerZombies: null,
      },
      resources: {
        cpuLimit: "unknown",
        memoryLimit: "unknown",
        quotaUs: null,
        periodUs: null,
        usageUs: null,
        periods: null,
        throttled: null,
        throttledUs: null,
        memoryBytes: null,
        memoryLimitBytes: null,
        oom: null,
        oomKill: null,
      },
    };
    type Item = (typeof queue)[number];
    const publish = (item: Item, snapshot: Snapshot) => {
      emit(item.phase, "readiness", item.readiness);
      emit(item.phase, "process", snapshot.processes);
      emit(item.phase, "kernel", snapshot.resources);
      if (initial) {
        const before = { ...initial.processes, ...initial.resources },
          after = { ...snapshot.processes, ...snapshot.resources };
        const delta: Record<string, number | null> = {};
        for (const key of [
          "processes",
          "rssKiB",
          "groupProcesses",
          "groupRssKiB",
          "usageUs",
          "periods",
          "throttled",
          "throttledUs",
          "memoryBytes",
          "oom",
          "oomKill",
        ] as const) {
          const a = before[key],
            b = after[key];
          const value = a === null || b === null ? null : b - a;
          delta[key] =
            value !== null &&
            Number.isSafeInteger(value) &&
            (!["usageUs", "periods", "throttled", "throttledUs", "oom", "oomKill"].includes(key) ||
              value >= 0)
              ? value
              : null;
        }
        emit(item.phase, "delta", delta);
      } else if (item.phase === "start") initial = snapshot;
    };
    let unavailable = false;
    const drain = () => {
      if (unavailable) {
        for (const item of queue.splice(0)) publish(item, unknown);
        return;
      }
      if (running || !queue.length) return;
      const item = queue.shift();
      if (!item) return;
      running = true;
      // One actual sample in flight. On timeout permanently stop sampling this launch.
      const timer = setTimeout(() => {
        unavailable = true;
        publish(item, unknown);
        drain();
      }, 1200);
      timer.unref();
      void sample(child, port)
        .then((snapshot) => {
          if (!unavailable) publish(item, snapshot);
        })
        .catch(() => {
          if (!unavailable) publish(item, unknown);
        })
        .finally(() => {
          clearTimeout(timer);
          running = false;
          drain();
        });
    };
    const request = (phase: Phase) => {
      if (snapshots++ >= 3) return;
      queue.push({
        phase,
        readiness: { outcome, attempts, deadlines, transports, status, cause, readyPort },
      });
      drain();
    };
    const safe = (callback: () => void) => {
      try {
        callback();
      } catch {
        /* Observation only. */
      }
    };
    const detach: (() => void)[] = [];
    // A separate bounded ready-line parser. Existing cue/history parsing is untouched.
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const decoder = new StringDecoder("utf8");
      let partial = "",
        dropping = false,
        consumed = 0;
      const parse = (chunk: Buffer | string) =>
        safe(() => {
          if (finished || consumed >= 65536) return;
          const remaining = 65536 - consumed;
          const input =
            typeof chunk === "string" ? chunk.slice(0, remaining) : chunk.subarray(0, remaining);
          consumed += input.length;
          const text = typeof input === "string" ? input : decoder.write(input);
          for (const character of text) {
            if (character === "\n") {
              if (!dropping) {
                const clean = partial.replace(
                  new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
                  "",
                );
                const match =
                  /^\[wrangler:info\] Ready on https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\r?$/.exec(
                    clean,
                  );
                if (match && bounded(Number(match[1]), 1, 65535)) {
                  const next = Number(match[1]) === port ? "match" : "mismatch";
                  readyPort = readyPort === "unknown" || readyPort === next ? next : "conflict";
                }
              }
              partial = "";
              dropping = false;
            } else if (!dropping) {
              if (partial.length + character.length > 256) {
                partial = "";
                dropping = true;
              } else partial += character;
            }
          }
          // Never interpret a partial line when the byte budget is exhausted.
          if (consumed >= 65536) {
            partial = "";
            dropping = true;
          }
        });
      stream.on("data", parse);
      detach.push(() => {
        stream.off("data", parse);
      });
    }
    request("start");
    const failedProbe = () => {
      if (!stalled && (outcome === "deadline" || attempts >= 25)) {
        stalled = true;
        request("stall");
      }
    };
    return {
      response: (code: number) =>
        safe(() => {
          if (finished) return;
          attempts = Math.min(999999, attempts + 1);
          status = bounded(code, 100, 599) ? code : null;
          cause = null;
          outcome = "response";
          if (code < 200 || code >= 300) failedProbe();
        }),
      failure: (error: unknown, deadline: boolean) =>
        safe(() => {
          if (finished) return;
          attempts = Math.min(999999, attempts + 1);
          status = null;
          cause = null;
          if (deadline) {
            deadlines = Math.min(attempts, deadlines + 1);
            outcome = "deadline";
          } else {
            transports = Math.min(attempts, transports + 1);
            outcome = "transport";
          }
          try {
            if (error !== null && typeof error === "object") {
              const nested = Object.getOwnPropertyDescriptor(error, "cause")?.value;
              const code = Object.getOwnPropertyDescriptor(
                nested !== null && typeof nested === "object" ? nested : error,
                "code",
              )?.value;
              if (member(code, causes)) cause = code as Cause;
            }
          } catch {
            /* Unavailable cause stays null; still observe the failed probe. */
          }
          failedProbe();
        }),
      finish: (ready: boolean) =>
        safe(() => {
          if (finished) return;
          finished = true;
          for (const remove of detach.splice(0)) remove();
          outcome = ready ? "ready" : "failed";
          request("end");
        }),
    };
  } catch {
    return noop;
  }
}
