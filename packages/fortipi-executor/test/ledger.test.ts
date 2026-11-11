import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaults } from "../dist/config.js";
import { Guard, Ledger, ledgerRegistryIdentity, rootRegistry } from "../dist/ledger.js";
import { Output } from "../dist/output.js";
import { assignment, fixture } from "./fixtures/daemon.ts";

const exec = promisify(execFile);
const daemon = fileURLToPath(new URL("./fixtures/daemon.ts", import.meta.url));
test("FULL start intent survives abrupt process exit; reopen cannot win another start", async () => {
  const f = await fixture();
  try {
    const a = await assignment("this must never be spawned");
    await assert.rejects(
      exec(process.execPath, [daemon, "claim-crash", f.directory, JSON.stringify(a)]),
      { code: 71 },
    );
    f.ledger.recover();
    assert.equal(f.ledger.get(a.identity.jobId)?.state, "unknown");
    assert.equal(
      f.ledger.claim(a.identity.jobId, "key", "synthetic-root", a.identity.jobId),
      false,
    );
    const changed = structuredClone(a);
    changed.identity.lease.fence = "2";
    assert.throws(() => f.ledger.admit(changed, "key"), /identity conflict/);
    assert.equal(f.ledger.rootAvailable("synthetic-root"), false);
  } finally {
    await f.cleanup();
  }
});
test("actual SQLite page exhaustion rolls output back and retains the original uncertain start identity", async () => {
  const f = await fixture();
  try {
    const a = await assignment("never"),
      row = f.ledger.admit(a, "approval");
    row.decision = "allow";
    f.ledger.put(row);
    assert.equal(f.ledger.claim(a.identity.jobId, "approval", f.root.key, a.identity.jobId), true);
    const pages = f.ledger.db.prepare("PRAGMA page_count").get() as { page_count: number };
    f.ledger.db.exec(`PRAGMA max_page_count=${pages.page_count + 1}`);
    const output = new Output(f.ledger, a.identity, f.ledger.limits);
    assert.throws(() => output.append("stdout", Buffer.from("x".repeat(50000))), /full|space/i);
    assert.equal(f.ledger.get(a.identity.jobId)?.bodyHash, row.bodyHash);
    assert.equal(f.ledger.get(a.identity.jobId)?.state, "start_intent");
    assert.equal(f.ledger.outbox().length, 0);
    f.ledger.db.exec("PRAGMA max_page_count=32768");
    f.ledger.recover();
    assert.equal(f.ledger.get(a.identity.jobId)?.state, "unknown");
    assert.equal(f.ledger.claim(a.identity.jobId, "approval", f.root.key, a.identity.jobId), false);
  } finally {
    await f.cleanup();
  }
});
test("an actual interrupted SQLite write reopens with its protected hot journal and preserves committed bytes", async () => {
  const f = await fixture();
  let reopened: Ledger | undefined;
  f.ledger.db.prepare("INSERT INTO meta VALUES ('durable_canary','before')").run();
  f.ledger.close();
  try {
    await assert.rejects(exec(process.execPath, [daemon, "journal-crash", f.directory]), {
      code: 74,
    });
    reopened = await Ledger.open(f.directory, "ledger", defaults);
    assert.equal(
      (
        reopened.db.prepare("SELECT value FROM meta WHERE key='durable_canary'").get() as {
          value: string;
        }
      ).value,
      "before",
    );
  } finally {
    reopened?.close();
    await rm(f.path, { recursive: true, force: true });
  }
});
test("SQLite guards exclude another process and alternate profile ledger for the same root", async () => {
  const f = await fixture();
  let guard: Guard | undefined;
  try {
    const path = join(f.directory, "guard.sqlite");
    guard = await Guard.acquire(path);
    await assert.rejects(exec(process.execPath, [daemon, "guard", path]), (e: unknown) => {
      assert.equal((e as { stdout: string }).stdout.trim(), "locked");
      return true;
    });
    guard.close();
    guard = undefined;
    assert.equal((await exec(process.execPath, [daemon, "guard", path])).stdout.trim(), "acquired");
    const registry = join(f.path, "registry");
    const g = await rootRegistry(registry, [
      { key: f.root.key, ledgerId: "a", ledgerPath: f.directory },
    ]);
    for (const lock of g) lock.close();
    await assert.rejects(
      rootRegistry(registry, [{ key: f.root.key, ledgerId: "b", ledgerPath: f.directory }]),
      /another ledger/,
    );
  } finally {
    guard?.close();
    await f.cleanup();
  }
});
test("one winning start claim; renewable expiry is stable, changed body conflicts; lost ledger is never rebuilt", async () => {
  const f = await fixture();
  try {
    const a = await assignment("true"),
      row = f.ledger.admit(a, "key");
    row.decision = "allow";
    f.ledger.put(row);
    const renewed = structuredClone(a);
    renewed.identity.lease.expiresAt += 1000;
    renewed.identity.lease.leaseVersion++;
    assert.equal(f.ledger.admit(renewed, "key").bodyHash, row.bodyHash);
    assert.equal(f.ledger.claim(a.identity.jobId, "key", f.root.key, a.identity.jobId), true);
    assert.equal(f.ledger.claim(a.identity.jobId, "key", f.root.key, a.identity.jobId), false);
    const changed = structuredClone(a);
    changed.arguments.command = "different";
    assert.throws(() => f.ledger.admit(changed, "key"), /identity conflict/);
    assert.throws(() => f.ledger.capacity(f.ledger.limits.ledgerBytes), /capacity exhausted/);
  } finally {
    await f.cleanup();
  }
  const lost = await fixture();
  lost.ledger.close();
  await rm(join(lost.directory, "ledger.sqlite"));
  try {
    await assert.rejects(Ledger.open(lost.directory, "ledger", defaults));
    assert.match(await readFile(join(lost.directory, "identity.json"), "utf8"), /ledger/);
  } finally {
    await rm(lost.path, { recursive: true, force: true });
  }
});
test("executor generation cannot replace its durable ledger by selecting another root or profile", async () => {
  const f = await fixture();
  const registry = join(f.path, "independent-registry");
  const identity = ledgerRegistryIdentity(f.profile, f.directory, "provision");
  try {
    for (const guard of await rootRegistry(registry, [], undefined, identity)) guard.close();
    await assert.rejects(rootRegistry(registry, [], undefined, identity), /already bound/);
    for (const guard of await rootRegistry(registry, [], undefined, { ...identity, mode: "bind" }))
      guard.close();
    await assert.rejects(
      rootRegistry(
        registry,
        [
          {
            key: "different-root",
            ledgerId: "replacement",
            ledgerPath: join(f.path, "replacement"),
          },
        ],
        undefined,
        {
          ...identity,
          mode: "bind",
          ledgerId: "replacement",
          ledgerPath: join(f.path, "replacement"),
        },
      ),
      /already bound/,
    );
    for (const guard of await rootRegistry(registry, [], undefined, {
      ...identity,
      executorGeneration: identity.executorGeneration + 1,
    }))
      guard.close();
    // Registry loss must not erase its separately persisted identity sentinel.
    await rm(join(registry, "registry.sqlite"));
    await assert.rejects(rootRegistry(registry, [], undefined, { ...identity, mode: "bind" }));
  } finally {
    await f.cleanup();
  }
});
