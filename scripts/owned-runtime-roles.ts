// Linux-only, owned-child observation. No arguments, environment, global process/port scan,
// debugger, native frames or process-order inference. All identities remain private.
import { type ChildProcess, spawn } from "node:child_process";
import { open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { URL } from "node:url";

const states = ["R", "S", "D", "T", "t", "I", "W", "P"] as const;
type State = (typeof states)[number];
type Proc = {
  pid: number;
  parent: number;
  group: number;
  session: number;
  start: bigint;
  ticks: bigint;
  state: State;
};
type Identity = Proc & { exe: string; device: number; inode: number };
type Stage = "unsupported" | "owner" | "executable" | "lineage" | "socket" | "identity" | "bounds";
type SocketTool = "ok" | "timeout" | "error" | "output-limit" | "cleanup-unconfirmed";
type SocketOutput = { tool: SocketTool; closed: boolean; text: string | null };
const addressForms = ["ipv4-loopback", "ipv6-loopback", "ipv6-mapped", "other"] as const;
type SocketFacts = {
  sample: "first" | "second";
  tool: SocketTool;
  closed: boolean;
  listeners: "none" | "one" | "multiple" | "unreadable";
  layout: "none" | "plain" | "netid" | "mixed" | "unreadable";
  address:
    | "none"
    | "ipv4-loopback"
    | "ipv6-loopback"
    | "ipv6-mapped"
    | "other"
    | "mixed"
    | "unreadable";
  owner: "none" | "target" | "owned-other" | "foreign" | "multiple" | "unreadable";
  addressForms: (typeof addressForms)[number][];
};
export type RoleObservation = {
  diagnostic: "owned-runtime-role";
  phase: "baseline" | "busy";
  status: "available" | "unavailable";
  stage: Stage | "complete";
  elapsedMs: number | null;
  roles: { role: "proxy" | "user"; ticks: number; state: State }[] | null;
  nativeFrames: "unproven";
  socket?: SocketFacts;
};

/** Pure bounded parsers; their fixtures cannot establish live ownership. */
export function ownedProcStat(text: string): Proc {
  if (text.length > 4096) throw new Error("stat bounds");
  const head = /^(\d{1,10}) \(/.exec(text),
    end = text.lastIndexOf(") ");
  if (!head || end < head[0].length) throw new Error("stat shape");
  const fields = text
    .slice(end + 2)
    .trimEnd()
    .split(" ");
  if (fields.length < 22 || fields.length > 64 || !states.includes(fields[0] as State))
    throw new Error("stat state");
  const integer = (value: string | undefined) => {
    if (!value || !/^\d{1,20}$/.test(value)) throw new Error("stat number");
    return BigInt(value);
  };
  const pid = (value: string | undefined) => {
    const n = integer(value);
    if (n > 2147483647n) throw new Error("stat identity");
    return Number(n);
  };
  return {
    pid: pid(head[1]),
    parent: pid(fields[1]),
    group: pid(fields[2]),
    session: pid(fields[3]),
    start: integer(fields[19]),
    ticks: integer(fields[11]) + integer(fields[12]),
    state: fields[0] as State,
  };
}

export function ownedSocketPid(text: string, port: number, owned: ReadonlySet<number>): number {
  if (text.length > 8192 || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("socket bounds");
  const rows = text.trim().split("\n");
  if (rows.length < 1 || rows.length > 2) throw new Error("socket ambiguity");
  const hosts = new Set<string>();
  let owner: number | undefined;
  for (const row of rows) {
    const match =
      /^LISTEN[ \t]+\d{1,10}[ \t]+\d{1,10}[ \t]+(127\.0\.0\.1|\[::1\]):(\d{1,5})[ \t]+(0\.0\.0\.0|\*|\[::\]):\*[ \t]+users:\(\("[^"\\\r\n]{1,64}",pid=(\d{1,10}),fd=\d{1,10}\)\)$/.exec(
        row,
      );
    const host = match?.[1],
      pid = Number(match?.[4]);
    if (
      !match ||
      !host ||
      Number(match[2]) !== port ||
      !owned.has(pid) ||
      hosts.has(host) ||
      (owner !== undefined && owner !== pid) ||
      (host === "127.0.0.1" ? match[3] === "[::]" : match[3] === "0.0.0.0")
    )
      throw new Error("socket owner");
    hosts.add(host);
    owner = pid;
  }
  // The harness probes IPv4. An optional IPv6 loopback listener must have
  // exactly the same verified owner; wildcard/mapped/duplicate listeners fail.
  if (!hosts.has("127.0.0.1") || owner === undefined) throw new Error("socket endpoint");
  return owner;
}

/** Descriptive only. Membership refers to the verified snapshot, never a role grant. */
export function ownedSocketFacts(
  output: SocketOutput,
  port: number,
  targets: ReadonlySet<number>,
  owned: ReadonlySet<number>,
  sample: SocketFacts["sample"],
): SocketFacts {
  if (
    !["ok", "timeout", "error", "output-limit", "cleanup-unconfirmed"].includes(output.tool) ||
    typeof output.closed !== "boolean" ||
    (sample !== "first" && sample !== "second")
  )
    throw new Error("closed socket facts required");
  const facts: SocketFacts = {
    sample,
    tool: output.tool,
    closed: output.closed,
    listeners: "unreadable",
    layout: "unreadable",
    address: "unreadable",
    owner: "unreadable",
    addressForms: [],
  };
  if (
    output.tool !== "ok" ||
    !output.closed ||
    typeof output.text !== "string" ||
    output.text.length > 8192 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return facts;
  const text = output.text.trim();
  if (!text) return { ...facts, listeners: "none", layout: "none", address: "none", owner: "none" };
  const rows = text.split("\n"),
    layouts = new Set<SocketFacts["layout"]>(),
    addresses = new Set<SocketFacts["address"]>(),
    pids = new Set<number>();
  let readableOwners = true;
  for (const row of rows) {
    const match =
      /^(tcp[ \t]+)?LISTEN[ \t]+\d{1,10}[ \t]+\d{1,10}[ \t]+(\S{1,160})[ \t]+\S{1,160}(?:[ \t]+(.+))?$/.exec(
        row,
      );
    const local = /^(.*):(\d{1,5})$/.exec(match?.[2] ?? "");
    if (!match || !local || Number(local[2]) !== port) return facts;
    const host = (local[1] ?? "").replace(/^\[(.*)\]$/, "$1"),
      family = isIP(host);
    if (host !== "*" && !family) return facts;
    layouts.add(match[1] ? "netid" : "plain");
    addresses.add(
      family === 4 && host.startsWith("127.")
        ? "ipv4-loopback"
        : family === 6 && /^(?:::ffff:|0:0:0:0:0:ffff:)/i.test(host)
          ? "ipv6-mapped"
          : /^(?:::1|0:0:0:0:0:0:0:1)$/.test(host)
            ? "ipv6-loopback"
            : "other",
    );
    const owners = /^users:\((.*)\)$/.exec(match[3] ?? "");
    const entries = [
      ...(owners?.[1] ?? "").matchAll(/\("[^"\\\r\n]{1,64}",pid=(\d{1,10}),fd=\d{1,10}\)/g),
    ];
    if (!entries.length || entries.map((entry) => entry[0]).join(",") !== owners?.[1])
      readableOwners = false;
    for (const entry of entries) {
      const pid = Number(entry[1]);
      if (pid < 1 || pid > 2147483647) readableOwners = false;
      else pids.add(pid);
    }
  }
  const pid = [...pids][0];
  return {
    ...facts,
    listeners: rows.length === 1 ? "one" : "multiple",
    layout: layouts.size === 1 ? ([...layouts][0] as SocketFacts["layout"]) : "mixed",
    address: addresses.size === 1 ? ([...addresses][0] as SocketFacts["address"]) : "mixed",
    addressForms: addressForms.filter((form) => addresses.has(form)),
    owner:
      !readableOwners || pid === undefined
        ? "unreadable"
        : pids.size > 1
          ? "multiple"
          : targets.has(pid)
            ? "target"
            : owned.has(pid)
              ? "owned-other"
              : "foreign",
  };
}

async function boundedProc(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error("proc bounds");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}
async function identity(pid: number): Promise<Identity> {
  const row = ownedProcStat(await boundedProc(`/proc/${pid}/stat`));
  const exe = await readlink(`/proc/${pid}/exe`),
    metadata = await stat(`/proc/${pid}/exe`);
  const again = ownedProcStat(await boundedProc(`/proc/${pid}/stat`));
  if (row.pid !== pid || row.start !== again.start || exe.length > 4096 || !metadata.isFile())
    throw new Error("identity changed");
  return { ...again, exe, device: metadata.dev, inode: metadata.ino };
}
function same(a: Identity, b: Identity): boolean {
  return (
    a.pid === b.pid &&
    a.start === b.start &&
    a.parent === b.parent &&
    a.group === b.group &&
    a.session === b.session &&
    a.exe === b.exe &&
    a.device === b.device &&
    a.inode === b.inode
  );
}
async function lineage(owner: number): Promise<Map<number, Identity>> {
  const rows = new Map<number, Identity>();
  const deadline = performance.now() + 1000;
  const visit = async (pid: number, parent: number, depth: number) => {
    if (performance.now() > deadline || depth > 8 || rows.size >= 64 || rows.has(pid))
      throw new Error("lineage bounds");
    const row = await identity(pid);
    if (row.parent !== parent || row.group !== owner || row.session !== owner)
      throw new Error("foreign lineage");
    rows.set(pid, row);
    // A Node worker thread may spawn a child. Inspect only this owned process's tasks.
    const tasks = await readdir(`/proc/${pid}/task`),
      children = new Set<string>();
    if (tasks.length > 512) throw new Error("task bounds");
    for (const task of tasks) {
      if (performance.now() > deadline) throw new Error("lineage deadline");
      if (!/^\d{1,10}$/.test(task)) throw new Error("task shape");
      const text = (await boundedProc(`/proc/${pid}/task/${task}/children`)).trim();
      if (text && !/^\d{1,10}(?: \d{1,10})*$/.test(text)) throw new Error("children shape");
      for (const value of text ? text.split(" ") : []) children.add(value);
      if (children.size > 64) throw new Error("children bounds");
    }
    for (const value of children) {
      const child = Number(value);
      if (child < 1 || child > 2147483647) throw new Error("child bounds");
      await visit(child, pid, depth + 1);
    }
    if (!same(row, await identity(pid))) throw new Error("lineage changed");
  };
  await visit(owner, process.pid, 0);
  return rows;
}

async function socketOutput(executable: string, port: number): Promise<SocketOutput> {
  return new Promise((accept) => {
    const child = spawn(executable, ["-H", "-ltnp", `( sport = :${port} )`], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false,
      stopping = false,
      bytes = 0;
    const chunks: Buffer[] = [];
    let force: ReturnType<typeof setTimeout> | undefined;
    let reason: SocketTool | undefined;
    const finish = (tool: SocketTool, closed: boolean, text: string | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(force);
      chunks.length = 0;
      accept({ tool, closed, text });
    };
    const stop = (tool: SocketTool) => {
      if (stopping || settled) return;
      stopping = true;
      reason = tool;
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already closed. */
        }
      child.kill("SIGKILL");
      force = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish("cleanup-unconfirmed", false);
      }, 250);
    };
    const timer = setTimeout(() => stop("timeout"), 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8192) stop("output-limit");
      else if (!stopping && !settled) chunks.push(chunk);
    });
    child.stderr.on("data", () => stop("error"));
    child.once("error", () => {
      if (child.pid) stop("error");
      else finish("error", true);
    });
    child.once("close", (code) =>
      finish(
        reason ?? (code === 0 ? "ok" : "error"),
        true,
        code === 0 && !stopping ? Buffer.concat(chunks).toString("utf8") : null,
      ),
    );
  });
}
async function pinnedExecutable() {
  const worker = createRequire(new URL("../apps/worker/package.json", import.meta.url));
  const wrangler = createRequire(worker.resolve("wrangler"));
  const miniflare = createRequire(wrangler.resolve("miniflare"));
  const workerd = miniflare("workerd") as { default: string; version: string };
  if (
    worker("wrangler/package.json").version !== "4.162.0" ||
    wrangler("miniflare/package.json").version !== "5.20261113.0-beta" ||
    workerd.version !== "1.20261113.1"
  )
    throw new Error("unreviewed runtime graph");
  const path = await realpath(workerd.default),
    metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) throw new Error("runtime executable");
  return { path, device: metadata.dev, inode: metadata.ino };
}

/** Exactly two snapshots separated by500ms; the front socket defines proxy, never order. */
export async function observeOwnedRuntimeRoles(
  child: ChildProcess,
  frontPort: number,
  phase: RoleObservation["phase"],
  beginWork?: () => void,
): Promise<RoleObservation> {
  if (phase !== "baseline" && phase !== "busy") throw new Error("closed phase required");
  let stage: Stage = "unsupported";
  let socketFacts: SocketFacts | undefined;
  const unavailable = (): RoleObservation => ({
    diagnostic: "owned-runtime-role",
    phase,
    status: "unavailable",
    stage,
    elapsedMs: null,
    roles: null,
    nativeFrames: "unproven",
    ...(stage === "socket" && socketFacts ? { socket: socketFacts } : {}),
  });
  if (process.platform !== "linux") return unavailable();
  try {
    stage = "owner";
    const pid = child.pid;
    if (
      !pid ||
      child.spawnfile !== process.execPath ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      !Number.isInteger(frontPort) ||
      frontPort < 1 ||
      frontPort > 65535
    )
      return unavailable();
    stage = "executable";
    const pinned = await pinnedExecutable(),
      node = await realpath(process.execPath),
      nodeStat = await stat(node);
    const ss = await realpath("/usr/bin/ss"),
      ssStat = await stat(ss);
    if (
      !ss.startsWith("/usr/") ||
      !ssStat.isFile() ||
      ssStat.uid !== 0 ||
      (ssStat.mode & 0o022) !== 0 ||
      (ssStat.mode & 0o111) === 0
    )
      return unavailable();
    stage = "lineage";
    const began = performance.now();
    const first = await lineage(pid),
      root = first.get(pid);
    if (root?.exe !== node || root.device !== nodeStat.dev || root.inode !== nodeStat.ino)
      return unavailable();
    const runtime = (rows: Map<number, Identity>) =>
      [...rows.values()].filter(
        (row) =>
          row.exe === pinned.path && row.device === pinned.device && row.inode === pinned.inode,
      );
    const before = runtime(first);
    if (before.length !== 2) return unavailable();
    const socket = async (rows: Map<number, Identity>, sample: SocketFacts["sample"]) => {
      socketFacts = undefined;
      const output = await socketOutput(ss, frontPort),
        targets = new Set(runtime(rows).map((row) => row.pid));
      socketFacts = ownedSocketFacts(output, frontPort, targets, new Set(rows.keys()), sample);
      if (output.tool !== "ok" || !output.closed || output.text === null)
        throw new Error("socket unavailable");
      return ownedSocketPid(output.text, frontPort, targets);
    };
    stage = "socket";
    const proxy = await socket(first, "first");
    stage = "identity";
    // The explicit private control starts work only after the first verified snapshot.
    beginWork?.();
    await pause(500);
    const second = await lineage(pid),
      elapsedMs = Math.round(performance.now() - began);
    if (
      first.size !== second.size ||
      [...first].some(([id, row]) => !second.has(id) || !same(row, second.get(id) as Identity)) ||
      runtime(second).length !== 2 ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return unavailable();
    stage = "socket";
    if ((await socket(second, "second")) !== proxy) return unavailable();
    stage = "bounds";
    if (elapsedMs < 500 || elapsedMs > 5000) return unavailable();
    const roles: NonNullable<RoleObservation["roles"]> = [];
    for (const role of ["proxy", "user"] as const) {
      const row = before.find((row) => (row.pid === proxy) === (role === "proxy"));
      if (!row) return unavailable();
      const after = second.get(row.pid);
      if (!after || !same(after, await identity(row.pid))) return unavailable();
      const delta = after.ticks - row.ticks;
      if (delta < 0n || delta > 1000000n) return unavailable();
      roles.push({ role, ticks: Number(delta), state: after.state });
    }
    if (child.exitCode !== null || child.signalCode !== null || !same(root, await identity(pid)))
      return unavailable();
    return {
      diagnostic: "owned-runtime-role",
      phase,
      status: "available",
      stage: "complete",
      elapsedMs,
      roles,
      nativeFrames: "unproven",
    };
  } catch {
    return unavailable();
  }
}
