import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaults } from "../dist/config.js";
import { Ledger } from "../dist/ledger.js";
import { HttpTransport } from "../dist/transport.js";
import { LocalWorkspace } from "../dist/workspace/local.js";
import { Staging } from "../dist/workspace/staging.js";
import { assignment, credential, fixture, importRoot } from "./fixtures/daemon.ts";

async function oracle(Constructor: typeof Ledger): Promise<void> {
  const f = await fixture();
  let ledger: Ledger | undefined;
  try {
    f.ledger.close();
    ledger = await Constructor.open(f.directory, "ledger", defaults);
    const a = await assignment("never");
    const row = ledger.admit(a, "key");
    row.decision = "allow";
    ledger.put(row);
    assert.equal(ledger.claim(a.identity.jobId, "key", f.root.key, a.identity.jobId), true);
    assert.equal(
      ledger.claim(a.identity.jobId, "key", f.root.key, a.identity.jobId),
      false,
      "duplicate claim must lose",
    );
  } finally {
    ledger?.close();
    const { rm } = await import("node:fs/promises");
    await rm(f.path, { recursive: true, force: true });
  }
}
await oracle(Ledger);
async function driftOracle(Constructor: typeof LocalWorkspace): Promise<void> {
  const f = await fixture();
  try {
    const staging = new Staging(
      `${f.directory}/staging`,
      f.ledger,
      new HttpTransport(f.profile, fetch, true),
    );
    await staging.initialize();
    const binding = f.profile.bindings[0];
    if (!binding) throw new Error("binding missing");
    const local = new Constructor(f.root, binding, f.profile, f.ledger, staging);
    await importRoot(local);
    await writeFile(`${f.rootPath}/external-edit`, "unexpected host effect");
    await assert.rejects(
      local.request({
        kind: "snapshot",
        operationId: "read",
        workspaceId: "workspace",
        bindingVersion: 1,
        rootBindingId: "root",
        executorId: "executor",
        executorGeneration: 7,
        credential,
        revision: "r0",
        deadline: Date.now() + 10000,
      }),
      /local_drift/,
      "revision oracle must reject host drift",
    );
  } finally {
    await f.cleanup();
  }
}
await driftOracle(LocalWorkspace);
const localPath = fileURLToPath(new URL("../dist/workspace/local.js", import.meta.url)),
  localSource = await readFile(localPath, "utf8"),
  driftPredicate = "current.manifestHash !== expected";
if (!localSource.includes(driftPredicate)) throw new Error("drift mutation predicate missing");
const driftTarget = localPath.replace(/local\.js$/, `local.mutant-${randomUUID()}.js`);
try {
  await writeFile(driftTarget, localSource.replace(driftPredicate, "false"), { flag: "wx" });
  const loaded = (await import(pathToFileURL(driftTarget).href)) as {
    LocalWorkspace: typeof LocalWorkspace;
  };
  await assert.rejects(
    driftOracle(loaded.LocalWorkspace),
    /revision oracle must reject host drift/,
  );
  process.stdout.write(
    "Sensitivity observed: bypassing full-manifest comparison accepts externally edited revision bytes; the independent revision oracle rejected it.\n",
  );
} finally {
  await unlink(driftTarget);
}
await driftOracle(LocalWorkspace);
const path = fileURLToPath(new URL("../dist/ledger.js", import.meta.url)),
  source = await readFile(path, "utf8");
const claimStart = source.indexOf("claim(id,"),
  claimEnd = source.indexOf("    pin(root,", claimStart);
if (claimStart < 0 || claimEnd < 0) throw new Error("mutation anchor missing");
const section = source.slice(claimStart, claimEnd);
const predicate = section.includes('row.state !== "pending"')
  ? 'row.state !== "pending"'
  : 'row?.state !== "pending"';
if (!section.includes(predicate)) throw new Error("winning CAS mutation predicate missing");
const mutant =
  source.slice(0, claimStart) + section.replace(predicate, "false") + source.slice(claimEnd);
const target = path.replace(/ledger\.js$/, `ledger.mutant-${randomUUID()}.js`);
try {
  await writeFile(target, mutant, { flag: "wx" });
  const loaded = (await import(pathToFileURL(target).href)) as { Ledger: typeof Ledger };
  await assert.rejects(oracle(loaded.Ledger), /duplicate claim must lose/);
  process.stdout.write(
    "Sensitivity observed: removing the winning start CAS permits a second durable claim; independent duplicate-start oracle rejected it.\n",
  );
} finally {
  await unlink(target);
}
await oracle(Ledger);
