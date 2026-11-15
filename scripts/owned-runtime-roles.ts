// Linux-only, owned-child observation. No arguments, environment, global process/port scan,
// debugger, native frames or process-order inference. All identities remain private.
import { type ChildProcess, spawn } from "node:child_process";
import { open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as pause } from "node:timers/promises";

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
export type RoleObservation = {
  diagnostic: "owned-runtime-role";
  phase: "baseline" | "busy";
  status: "available" | "unavailable";
  stage: Stage | "complete";
  elapsedMs: number | null;
  roles: { role: "proxy" | "user"; ticks: number; state: State }[] | null;
  nativeFrames: "unproven";
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
  if (rows.length !== 1) throw new Error("socket ambiguity");
  const match =
    /^LISTEN[ \t]+\d{1,10}[ \t]+\d{1,10}[ \t]+127\.0\.0\.1:(\d{1,5})[ \t]+(?:0\.0\.0\.0|\*):\*[ \t]+users:\(\("[^"\\\r\n]{1,64}",pid=(\d{1,10}),fd=\d{1,10}\)\)$/.exec(
      rows[0] ?? "",
    );
  const pid = Number(match?.[2]);
  if (!match || Number(match[1]) !== port || !owned.has(pid)) throw new Error("socket owner");
  return pid;
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

async function socketOutput(executable: string, port: number): Promise<string | undefined> {
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
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(force);
      chunks.length = 0;
      accept(value);
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
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
        finish();
      }, 250);
    };
    const timer = setTimeout(stop, 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8192) stop();
      else if (!stopping && !settled) chunks.push(chunk);
    });
    child.stderr.on("data", stop);
    child.once("error", () => {
      if (child.pid) stop();
      else finish();
    });
    child.once("close", (code) =>
      finish(code === 0 && !stopping ? Buffer.concat(chunks).toString("utf8") : undefined),
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
  const unavailable = (): RoleObservation => ({
    diagnostic: "owned-runtime-role",
    phase,
    status: "unavailable",
    stage,
    elapsedMs: null,
    roles: null,
    nativeFrames: "unproven",
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
    const socket = async (rows: Map<number, Identity>) => {
      const stdout = await socketOutput(ss, frontPort);
      if (stdout === undefined) throw new Error("socket unavailable");
      return ownedSocketPid(stdout, frontPort, new Set(runtime(rows).map((row) => row.pid)));
    };
    stage = "socket";
    const proxy = await socket(first);
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
    if ((await socket(second)) !== proxy) return unavailable();
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
