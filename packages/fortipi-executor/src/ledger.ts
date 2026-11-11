// Node26.13 DatabaseSync and Database are the same constructor; locked types name the alias.

import { randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync as Database } from "node:sqlite";
import type {
  Assignment,
  ExecutionIdentity,
  ExecutorFrame,
  JobCommitted,
  LocalObservation,
  LocalPrepare,
  LocalPrepared,
  PreparedResult,
  TransportAck,
} from "fortipi-contract/executor";
import { canonicalJson } from "fortipi-contract/executor";
import type { Limits, Profile } from "./config.js";
import { adapter, privateRead, privateWrite, secureDirectory } from "./config.js";
import type { PlatformAdapter } from "./platform/types.js";
import { assignmentBody, hash, immutableIdentity } from "./policy.js";
import type { Manifest } from "./workspace/manifest.js";

export interface JobRow {
  assignment: Assignment;
  bodyHash: string;
  state: "pending" | "start_intent" | "running" | "result" | "closed" | "unknown";
  approvalKey: string;
  decision: "pending" | "allow" | "deny";
  cancelled: boolean;
  incarnation: string;
  sequence: number;
  outputBytes: number;
  truncated: boolean;
  reservedBytes: number;
  result?: PreparedResult;
  committed?: JobCommitted;
  backendExecutionId?: string;
  reason?: string;
}
export interface LocalRow {
  request: LocalPrepare;
  prepared: LocalPrepared;
  observation: LocalObservation;
  manifest?: Manifest;
  journal: { path: string; state: "intent" | "done" }[];
  closed?: boolean;
}
export class Guard {
  db: Database;
  private constructor(db: Database) {
    this.db = db;
  }
  static async acquire(path: string, platform = adapter()): Promise<Guard> {
    await prepareDatabase(path, platform, false);
    const db = new Database(path, { timeout: 100 });
    try {
      db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS guard (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE",
      );
    } catch {
      db.close();
      throw new Error("executor or root already locked");
    }
    return new Guard(db);
  }
  close(): void {
    this.db.exec("ROLLBACK");
    this.db.close();
  }
}
async function prepareDatabase(
  path: string,
  platform: PlatformAdapter,
  mustExist: boolean,
): Promise<void> {
  await platform.verifyProtection(dirname(path), true);
  try {
    await platform.verifyProtection(path, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || mustExist) throw error;
    const file = await open(path, "wx", 0o600);
    await file.close();
    await platform.protect(path, false);
  }
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      await platform.verifyProtection(`${path}${suffix}`, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Main ledger is never reconstructed when its separately provisioned identity exists. */
export class Ledger {
  db: Database;
  readonly incarnation = randomUUID();
  readonly limits: Limits;
  readonly path: string;
  private constructor(path: string, db: Database, limits: Limits) {
    this.path = path;
    this.db = db;
    this.limits = limits;
  }
  static async provision(
    directory: string,
    ledgerId: string,
    limits: Limits,
    platform = adapter(),
  ): Promise<Ledger> {
    await secureDirectory(directory, platform);
    const identityPath = join(directory, "identity.json");
    try {
      await lstat(identityPath);
      throw new Error("identity already provisioned; open existing ledger");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Sentinel goes first: interruption here fails closed rather than silently allocating an empty replacement.
    await privateWrite(identityPath, canonicalJson({ version: 1, ledgerId }), platform, true);
    return Ledger.open(directory, ledgerId, limits, platform, true);
  }
  static async open(
    directory: string,
    ledgerId: string,
    limits: Limits,
    platform = adapter(),
    initializing = false,
  ): Promise<Ledger> {
    const identity = JSON.parse(await privateRead(join(directory, "identity.json"), platform)) as {
      ledgerId: string;
    };
    if (identity.ledgerId !== ledgerId) throw new Error("ledger identity mismatch");
    const path = join(directory, "ledger.sqlite");
    await prepareDatabase(path, platform, !initializing);
    const db = new Database(path, { timeout: 100 });
    try {
      db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF",
      );
      if ((db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok")
        throw new Error("corrupt ledger");
      const ledger = new Ledger(path, db, limits);
      if (initializing)
        db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE jobs (id TEXT PRIMARY KEY,body TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX job_state ON jobs(state,id);
        CREATE TABLE outbox (id TEXT PRIMARY KEY,job TEXT NOT NULL,sequence INTEGER NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0,UNIQUE(job,kind,sequence));
        CREATE INDEX pending_outbox ON outbox(acked,id);
        CREATE TABLE local_ops (id TEXT PRIMARY KEY,digest TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE revisions (id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE stages (id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE pins (root TEXT PRIMARY KEY,operation TEXT NOT NULL,quarantine INTEGER NOT NULL DEFAULT 0);
      `);
      else db.prepare("SELECT value FROM meta LIMIT 1").all(); // Missing schema is loss, never a migration to an empty ledger.
      return ledger;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  capacity(extraBytes = 0, admission = false): void {
    const pages = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const size = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    const rows = this.db.prepare("SELECT count(*) AS n FROM jobs").get() as { n: number };
    const reserved = Number(
      (
        this.db.prepare("SELECT value FROM meta WHERE key='reserved_bytes'").get() as
          | { value: string }
          | undefined
      )?.value ?? 0,
    );
    if (
      pages.page_count * size.page_size + extraBytes + (admission ? reserved : 0) >
        this.limits.ledgerBytes * (admission ? 0.75 : 1) ||
      (admission && rows.n >= this.limits.historyRows)
    )
      throw new Error("local capacity exhausted; dedup and receipt history retained");
  }
  get(id: string): JobRow | undefined {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as JobRow) : undefined;
  }
  put(row: JobRow): void {
    if (!this.db.isTransaction) {
      this.transaction(() => this.put(row));
      return;
    }
    const old = this.get(row.assignment.identity.jobId);
    if (
      !old ||
      old.bodyHash !== row.bodyHash ||
      row.bodyHash !== hash(assignmentBody(row.assignment))
    )
      throw new Error("immutable stored job identity conflict");
    if (old.state === "closed" && row.state !== "closed")
      throw new Error("closed attempt cannot be reopened");
    const remaining =
      row.state === "closed"
        ? 0
        : Math.max(0, old.reservedBytes - Math.max(0, row.outputBytes - old.outputBytes) * 2);
    const reserved = Number(
      (
        this.db.prepare("SELECT value FROM meta WHERE key='reserved_bytes'").get() as
          | { value: string }
          | undefined
      )?.value ?? 0,
    );
    this.db
      .prepare(
        "INSERT INTO meta VALUES ('reserved_bytes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(Math.max(0, reserved + remaining - old.reservedBytes)));
    row.reservedBytes = remaining;
    this.db
      .prepare("UPDATE jobs SET state=?,data=? WHERE id=?")
      .run(row.state, canonicalJson(row), row.assignment.identity.jobId);
  }
  admit(assignment: Assignment, approvalKey: string): JobRow {
    return this.transaction(() => {
      if (
        this.db
          .prepare("SELECT value FROM meta WHERE key=?")
          .get(`closed_${assignment.identity.jobId}`)
      )
        throw new Error("closed attempt cannot be admitted");
      const previous = this.get(assignment.identity.jobId);
      const bodyHash = hash(assignmentBody(assignment));
      if (previous) {
        if (previous.bodyHash !== bodyHash) throw new Error("job identity conflict");
        return previous;
      }
      this.capacity(
        Buffer.byteLength(canonicalJson(assignment)) * 4 + this.limits.outputBytesPerJob * 2,
        true,
      );
      const row: JobRow = {
        assignment,
        bodyHash,
        approvalKey,
        state: "pending",
        decision: "pending",
        cancelled: false,
        incarnation: this.incarnation,
        sequence: 0,
        outputBytes: 0,
        truncated: false,
        reservedBytes: this.limits.outputBytesPerJob * 2,
      };
      const reserved = Number(
        (
          this.db.prepare("SELECT value FROM meta WHERE key='reserved_bytes'").get() as
            | { value: string }
            | undefined
        )?.value ?? 0,
      );
      this.db
        .prepare(
          "INSERT INTO meta VALUES ('reserved_bytes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(String(reserved + row.reservedBytes));
      this.db
        .prepare("INSERT INTO jobs VALUES (?,?,?,?)")
        .run(assignment.identity.jobId, bodyHash, row.state, canonicalJson(row));
      return row;
    });
  }
  existing(identity: ExecutionIdentity): JobRow | undefined {
    const row = this.get(identity.jobId);
    if (row && immutableIdentity(row.assignment.identity) !== immutableIdentity(identity))
      throw new Error("execution identity conflict");
    return row;
  }
  pending(): JobRow[] {
    return (
      this.db
        .prepare("SELECT data FROM jobs WHERE state='pending' ORDER BY id LIMIT ?")
        .all(this.limits.queuedAdmissions) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as JobRow);
  }
  recover(): void {
    this.transaction(() => {
      for (const value of this.db.prepare("SELECT data FROM jobs WHERE state='pending'").all() as {
        data: string;
      }[]) {
        const row = JSON.parse(value.data) as JobRow;
        if (row.incarnation !== this.incarnation) {
          row.state = "closed";
          row.decision = "deny";
          row.reason = "pending assignment closed on restart; no replay";
          this.put(row);
        }
      }
      const rows = this.db
        .prepare("SELECT data FROM jobs WHERE state IN ('start_intent','running')")
        .all() as { data: string }[];
      for (const value of rows) {
        const row = JSON.parse(value.data) as JobRow;
        row.state = "unknown";
        row.reason = "previous incarnation may have started; query/reconcile only";
        this.put(row);
      }
      const locals = this.db.prepare("SELECT data FROM local_ops").all() as { data: string }[];
      for (const value of locals) {
        const row = JSON.parse(value.data) as LocalRow;
        if (row.observation.state === "applying") {
          row.observation = { ...row.observation, state: "unknown", reason: "interrupted apply" };
          this.saveLocal(row);
        }
      }
      this.db
        .prepare(
          "UPDATE pins SET quarantine=1 WHERE operation IN (SELECT id FROM jobs WHERE state='unknown')",
        )
        .run();
      // A root with an outstanding apply stays pinned even if no native job existed.
      this.db
        .prepare(
          "UPDATE pins SET quarantine=1 WHERE operation IN (SELECT id FROM local_ops WHERE json_extract(data,'$.observation.state') IN ('unknown','partial','drift'))",
        )
        .run();
    });
  }
  claim(id: string, key: string, root: string, operation: string): boolean {
    return this.transaction(() => {
      if (this.db.prepare("SELECT value FROM meta WHERE key=?").get(`closed_${id}`)) return false;
      const row = this.get(id);
      if (
        row?.state !== "pending" ||
        row.cancelled ||
        row.decision !== "allow" ||
        row.approvalKey !== key ||
        row.incarnation !== this.incarnation
      )
        return false;
      this.pin(root, operation);
      row.state = "start_intent";
      this.put(row); // The transaction is committed before the caller invokes spawn.
      return true;
    });
  }
  pin(root: string, operation: string): void {
    const pin = this.db.prepare("SELECT operation,quarantine FROM pins WHERE root=?").get(root) as
      | { operation: string; quarantine: number }
      | undefined;
    if (pin && (pin.operation !== operation || pin.quarantine))
      throw new Error("root pinned or quarantined; reconciliation required");
    this.db.prepare("INSERT OR IGNORE INTO pins VALUES (?,?,0)").run(root, operation);
  }
  quarantine(root: string): void {
    this.db.prepare("UPDATE pins SET quarantine=1 WHERE root=?").run(root);
  }
  release(root: string, operation: string): void {
    this.db
      .prepare("DELETE FROM pins WHERE root=? AND operation=? AND quarantine=0")
      .run(root, operation);
  }
  rootAvailable(root: string, operation?: string): boolean {
    const pin = this.db.prepare("SELECT operation,quarantine FROM pins WHERE root=?").get(root) as
      | { operation: string; quarantine: number }
      | undefined;
    return !pin || (!pin.quarantine && pin.operation === operation);
  }
  saveLocal(row: LocalRow): void {
    this.db
      .prepare(
        "INSERT INTO local_ops VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(row.request.operationId, row.request.operationDigest, canonicalJson(row));
  }
  local(id: string): LocalRow | undefined {
    const row = this.db.prepare("SELECT data FROM local_ops WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as LocalRow) : undefined;
  }
  saveRecord(table: "stages" | "revisions", id: string, value: unknown): void {
    const bytes = canonicalJson(value);
    const old = this.record<unknown>(table, id);
    if (old && canonicalJson(old) !== bytes) throw new Error("immutable record conflict");
    this.capacity(Buffer.byteLength(bytes));
    this.db.prepare(`INSERT OR IGNORE INTO ${table} VALUES (?,?)`).run(id, bytes);
  }
  record<T>(table: "stages" | "revisions", id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  enqueue(job: string, kind: "output" | "result", sequence: number, frame: ExecutorFrame): string {
    const data = canonicalJson(frame),
      digest = hash(data);
    const old = this.db
      .prepare("SELECT digest FROM outbox WHERE job=? AND kind=? AND sequence=?")
      .get(job, kind, sequence) as { digest: string } | undefined;
    if (old && old.digest !== digest) throw new Error("conflicting output repeat");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox(id,job,sequence,kind,digest,data) VALUES (?,?,?,?,?,?)",
      )
      .run(frame.requestId, job, sequence, kind, digest, data);
    return frame.requestId;
  }
  ack(ack: TransportAck, kind: "output" | "result"): void {
    const row = this.db
      .prepare("SELECT sequence,kind FROM outbox WHERE id=?")
      .get(ack.deliveryId) as { sequence: number; kind: string } | undefined;
    if (!ack.persisted || !row || row.kind !== kind || row.sequence !== ack.sequence)
      throw new Error("unexpected persisted acknowledgment");
    this.db.prepare("UPDATE outbox SET acked=1 WHERE id=?").run(ack.deliveryId);
  }
  outbox(limit = 32): ExecutorFrame[] {
    return (
      this.db
        .prepare("SELECT data FROM outbox WHERE acked=0 ORDER BY job,sequence,kind LIMIT ?")
        .all(limit) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as ExecutorFrame);
  }
  identities(): ExecutionIdentity[] {
    return (
      this.db
        .prepare("SELECT data FROM jobs WHERE state!='closed' ORDER BY id LIMIT ?")
        .all(this.limits.historyRows) as { data: string }[]
    ).map((r) => (JSON.parse(r.data) as JobRow).assignment.identity);
  }
  close(): void {
    this.db.close();
  }
}

/** Canonical per-user registry is independent of origin/profile aliases. */
export function ledgerRegistryIdentity(p: Profile, ledgerPath: string, mode: "bind" | "provision") {
  return {
    origin: p.origin,
    deploymentId: p.deploymentId,
    executorId: p.executorId,
    executorGeneration: p.executorGeneration,
    ledgerId: p.ledgerId,
    ledgerPath,
    mode,
  };
}
export async function rootRegistry(
  directory: string,
  roots: { key: string; ledgerId: string; ledgerPath: string }[],
  platform = adapter(),
  identity?: ReturnType<typeof ledgerRegistryIdentity>,
): Promise<Guard[]> {
  await secureDirectory(directory, platform);
  const guards: Guard[] = [];
  try {
    for (const root of [...new Map(roots.map((r) => [r.key, r])).values()].sort((a, b) =>
      a.key.localeCompare(b.key),
    ))
      guards.push(await Guard.acquire(join(directory, `${hash(root.key)}.guard.sqlite`), platform));
    const registryPath = join(directory, "registry.sqlite");
    let initializing = false;
    try {
      await privateRead(join(directory, "registry.identity.json"), platform);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      initializing = true;
      await privateWrite(
        join(directory, "registry.identity.json"),
        canonicalJson({ version: 1 }),
        platform,
        true,
      );
    }
    await prepareDatabase(registryPath, platform, !initializing);
    const db = new Database(registryPath, { timeout: 100 });
    try {
      db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS roots (id TEXT PRIMARY KEY,ledger TEXT NOT NULL,path TEXT NOT NULL); CREATE TABLE IF NOT EXISTS executors (id TEXT PRIMARY KEY,ledger TEXT NOT NULL,path TEXT NOT NULL); BEGIN IMMEDIATE",
      );
      if (identity) {
        const key = hash(
            canonicalJson({
              origin: identity.origin,
              deploymentId: identity.deploymentId,
              executorId: identity.executorId,
              executorGeneration: identity.executorGeneration,
            }),
          ),
          old = db.prepare("SELECT ledger,path FROM executors WHERE id=?").get(key) as
            | { ledger: string; path: string }
            | undefined;
        if (
          old &&
          (identity.mode === "provision" ||
            old.ledger !== identity.ledgerId ||
            old.path !== identity.ledgerPath)
        )
          throw new Error(
            "executor execution generation already bound; never provision a replacement ledger",
          );
        if (!old)
          db.prepare("INSERT INTO executors VALUES (?,?,?)").run(
            key,
            identity.ledgerId,
            identity.ledgerPath,
          );
      }
      for (const root of roots) {
        const previous = db.prepare("SELECT ledger,path FROM roots WHERE id=?").get(root.key) as
          | { ledger: string; path: string }
          | undefined;
        if (previous && (previous.ledger !== root.ledgerId || previous.path !== root.ledgerPath))
          throw new Error("root belongs to another ledger; explicit reconciliation required");
        db.prepare("INSERT OR IGNORE INTO roots VALUES (?,?,?)").run(
          root.key,
          root.ledgerId,
          root.ledgerPath,
        );
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    return guards;
  } catch (error) {
    for (const guard of guards.reverse()) guard.close();
    throw error;
  }
}
