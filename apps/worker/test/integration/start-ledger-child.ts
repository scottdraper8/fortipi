import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface StartObservation {
  scope: "complete-local-runtime" | "ledger-to-os-boundary";
  records: string[];
  pendingSync: boolean;
  repeatState: string;
  repeatError?: string;
  persistedState: string;
  sameBody: boolean;
  unchangedBase: boolean;
  protectedSqlite: boolean;
  siteCount?: number;
  compiledSha256?: string;
  scenarioSha256?: string;
}

async function scenario(build: string, nonce: string): Promise<StartObservation> {
  const load = (path: string) => import(pathToFileURL(join(build, path)).href);
  const fixtureModule = (await load(
    "test/fixtures/daemon.ts",
  )) as typeof import("../../../../packages/fortipi-executor/test/fixtures/daemon.ts");
  const { ExecutorRuntime } = (await load(
    "dist/daemon.js",
  )) as typeof import("../../../../packages/fortipi-executor/dist/daemon.js");
  const { HttpTransport } = (await load(
    "dist/transport.js",
  )) as typeof import("../../../../packages/fortipi-executor/dist/transport.js");
  const { approvalKey } = (await load(
    "dist/policy.js",
  )) as typeof import("../../../../packages/fortipi-executor/dist/policy.js");
  const { adapter } = (await load(
    "dist/config.js",
  )) as typeof import("../../../../packages/fortipi-executor/dist/config.js");
  const { fixture, assignment, nodeCommand, prepare, importRoot, authenticateFixture, eventually } =
    fixtureModule;
  const f = await fixture();
  const http = new HttpTransport(f.profile, fetch, true);
  authenticateFixture(http); // Synthetic CP/transport authority; no remote service.
  const runtime = new ExecutorRuntime({
    profile: f.profile,
    ledger: f.ledger,
    directory: f.directory,
    roots: new Map([["root", f.root]]),
    http,
  });
  try {
    await runtime.initialize();
    for (const local of runtime.locals.values()) await importRoot(local);
    runtime.connected = true; // Synthetic registration; runtime/policy/ledger/spawn stay real.
    const marker = join(f.path, "external-starts"); // Outside workspace: unchanged base bytes.
    const a = await assignment(
      nodeCommand(fileURLToPath(import.meta.url), "marker", marker, nonce),
    );
    const local = runtime.locals.get("root");
    assert.ok(local);
    await local.request(prepare(a, f.initial.manifestHash));
    await runtime.assignOnce(a);
    runtime.approvals.decide(
      a.identity.jobId,
      approvalKey(a, f.profile.policy, f.root.key),
      "allow",
    );
    await runtime.tick();
    await eventually(
      () => !!f.ledger.get(a.identity.jobId)?.result && runtime.active.size === 0,
      "native result did not persist",
    );
    assert.equal(f.ledger.get(a.identity.jobId)?.result?.state, "succeeded");
    assert.equal(runtime.queryExisting(a.identity).state, "pending_sync");
    assert.equal(
      (f.ledger.db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous,
      2,
    );
    const observation = local.ledger.local(a.identity.lease.operationId)?.observation;
    assert.equal(observation?.state, "applied");
    assert.equal(observation?.preManifestHash, f.initial.manifestHash);
    assert.equal(observation?.postManifestHash, f.initial.manifestHash);
    assert.deepEqual(await readdir(f.rootPath), []);
    const database = new DatabaseSync(f.ledger.path, { readOnly: true });
    try {
      const stored = () => {
        const row = database.prepare("SELECT data FROM jobs WHERE id=?").get(a.identity.jobId) as {
          data: string;
        };
        return JSON.parse(row.data) as {
          assignment: unknown;
          bodyHash: string;
          state: string;
          result?: { state: string };
          committed?: unknown;
        };
      };
      const before = stored();
      assert.equal(before.state, "result");
      assert.equal(before.result?.state, "succeeded");
      assert.equal(before.committed, undefined); // No committed receipt is fabricated.
      assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [nonce]);
      let repeatState = "rejected";
      let repeatError: string | undefined;
      try {
        repeatState = (await runtime.assignOnce(a)).state;
        await runtime.tick();
      } catch (error) {
        repeatError = error instanceof Error ? error.message : "repeat rejected";
      }
      await eventually(
        () => runtime.active.size === 0 && runtime.children.size === 0,
        "native repeat did not settle",
      );
      const after = stored();
      assert.equal(after.bodyHash, before.bodyHash);
      assert.deepEqual(after.assignment, before.assignment);
      assert.deepEqual(await readdir(f.rootPath), []);
      await adapter().verifyProtection(f.directory, true);
      await adapter().verifyProtection(f.ledger.path, false);
      const records = (await readFile(marker, "utf8")).trim().split("\n");
      assert.ok(
        records.every((record) => record === nonce),
        "unexpected external marker bytes",
      );
      return {
        scope: "complete-local-runtime",
        records,
        pendingSync: true,
        repeatState,
        ...(repeatError ? { repeatError } : {}),
        persistedState: after.state,
        sameBody: true,
        unchangedBase: true,
        protectedSqlite: true,
      };
    } finally {
      database.close();
    }
  } finally {
    try {
      await runtime.shutdown();
    } finally {
      await f.cleanup();
    }
  }
}

/** Component proof only: the complete runtime's independent journals are omitted. */
async function boundary(build: string, nonce: string): Promise<StartObservation> {
  const load = (path: string) => import(pathToFileURL(join(build, path)).href);
  const { fixture, assignment, nodeCommand } = (await load(
    "test/fixtures/daemon.ts",
  )) as typeof import("../../../../packages/fortipi-executor/test/fixtures/daemon.ts");
  const { adapter } = (await load(
    "dist/config.js",
  )) as typeof import("../../../../packages/fortipi-executor/dist/config.js");
  const { childEnvironment } = (await load(
    "dist/platform/types.js",
  )) as typeof import("../../../../packages/fortipi-executor/dist/platform/types.js");
  const f = await fixture();
  const platform = adapter();
  const marker = join(f.path, "external-component-starts");
  const a = await assignment(nodeCommand(fileURLToPath(import.meta.url), "marker", marker, nonce));
  const key = "synthetic-component-consent";
  const first = f.ledger.admit(a, key);
  first.decision = "allow";
  f.ledger.put(first);
  const database = new DatabaseSync(f.ledger.path, { readOnly: true });
  const stored = () => {
    const row = database.prepare("SELECT data FROM jobs WHERE id=?").get(a.identity.jobId) as {
      data: string;
    };
    return JSON.parse(row.data) as { assignment: unknown; bodyHash: string; state: string };
  };
  const spawnAfterClaim = async () => {
    if (!f.ledger.claim(a.identity.jobId, key, f.root.key, a.identity.jobId)) return false;
    // A second connection must observe durable intent before the actual OS call.
    assert.equal(stored().state, "start_intent");
    const child = platform.spawn(
      platform.shell(a.arguments.command as string, f.rootPath, childEnvironment()),
    );
    child.stdout?.resume();
    child.stderr?.resume();
    try {
      const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(5000) });
      assert.equal(code, 0);
      assert.equal(signal, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) await platform.cancel(child, 25);
    }
    return true;
  };
  try {
    assert.equal(
      (f.ledger.db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous,
      2,
    );
    const before = stored();
    assert.equal(await spawnAfterClaim(), true);
    assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [nonce]);
    assert.equal(stored().state, "start_intent");
    f.ledger.admit(a, key); // Repeated identical delivery; no reseeding or journal/pin reset.
    const second = await spawnAfterClaim();
    const after = stored();
    assert.equal(after.state, "start_intent");
    assert.equal(after.bodyHash, before.bodyHash);
    assert.deepEqual(after.assignment, before.assignment);
    assert.deepEqual(await readdir(f.rootPath), []);
    await platform.verifyProtection(f.directory, true);
    await platform.verifyProtection(f.ledger.path, false);
    const records = (await readFile(marker, "utf8")).trim().split("\n");
    assert.ok(records.every((record) => record === nonce));
    return {
      scope: "ledger-to-os-boundary",
      records,
      pendingSync: false,
      repeatState: second ? "claim-won" : "claim-rejected",
      persistedState: after.state,
      sameBody: true,
      unchangedBase: true,
      protectedSqlite: true,
    };
  } finally {
    database.close();
    await f.cleanup();
  }
}

if (import.meta.main) {
  const [mode, path, nonce] = process.argv.slice(2);
  assert.ok(path && nonce);
  if (mode === "marker") {
    const descriptor = openSync(path, "a", 0o600);
    try {
      writeSync(descriptor, `${nonce}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } else {
    assert.ok(mode === "scenario" || mode === "boundary");
    const result = await (mode === "boundary" ? boundary(path, nonce) : scenario(path, nonce));
    result.scenarioSha256 = createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex");
    console.log(JSON.stringify(result));
  }
}
