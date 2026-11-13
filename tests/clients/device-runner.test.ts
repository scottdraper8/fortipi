import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "../../packages/fortipi-contract/dist/index.js";
import type { DeploymentIdentity } from "../../scripts/verify-release-gates.ts";
import type { DeviceEvidenceData } from "./device-observer.ts";
import { liveRecoveryReady, readDeviceEvidenceData } from "./evidence.ts";
import { deviceSeedBytes } from "./live-device.ts";
import { argumentsFor } from "./run-evidence.ts";

async function metadataFixture(): Promise<{
  data: DeviceEvidenceData;
  current: DeploymentIdentity;
}> {
  // Reuse the controlled read fixture without importing/registering its tests.
  // No candidate, provider, phase artifact or job authenticity is fabricated.
  const source = await readFile(new URL("./device-observer.test.ts", import.meta.url), "utf8");
  const start = source.indexOf("const hash ="),
    end = source.indexOf("\ntest(", start);
  assert.ok(start >= 0 && end > start);
  const construct = new Function(
    "assert",
    "createHash",
    "canonicalJson",
    "deviceSeedBytes",
    `${stripTypeScriptTypes(source.slice(start, end))}\nreturn controlledHistory();`,
  );
  const { data, current }: { data: DeviceEvidenceData; current: DeploymentIdentity } = construct(
    assert,
    createHash,
    canonicalJson,
    deviceSeedBytes,
  );
  const provider0 = "00000000-0000-4000-8000-000000000010",
    worker0 = "00000000-0000-4000-8000-000000000020";
  const provider1 = "00000000-0000-4000-8000-000000000011",
    worker1 = "00000000-0000-4000-8000-000000000021";
  Object.assign(data.initial.deployment, {
    deploymentId: provider0,
    workerVersionId: worker0,
    versions: [{ versionId: worker0, percentage: 100 }],
  });
  data.a.deploymentId = provider0;
  data.b.deploymentId = provider0;
  data.a.workerVersionId = worker0;
  data.b.workerVersionId = worker0;
  Object.assign(current, {
    deploymentId: provider1,
    workerVersionId: worker1,
    versions: [{ versionId: worker1, percentage: 100 }],
  });
  return { data, current };
}

test("device CLI data is bounded private metadata outside output, without symlink/hardlink or authority substitution", async () => {
  const { data, current } = await metadataFixture();
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-device-transport-")));
  const out = resolve(root, "child"),
    path = resolve(root, "child.devices.json");
  await mkdir(out, { mode: 0o700 });
  const save = (value: unknown) => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    await save(data);
    assert.deepEqual(await readDeviceEvidenceData(path, out, current), data);
    const args = [
      "live",
      "--candidate",
      "candidate.json",
      "--fixture",
      "fixture.json",
      "--out",
      out,
      "--devices",
      path,
    ];
    assert.equal(argumentsFor(args).devicesReceipt, path);
    assert.throws(() => argumentsFor([...args.slice(0, -1), "relative.json"]));
    assert.throws(() => argumentsFor(["local", ...args.slice(1)]));
    assert.throws(() => argumentsFor([...args, "--devices", path]));
    await chmod(path, 0o644);
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
    await chmod(path, 0o600);
    const alias = resolve(root, "alias.json");
    await symlink(path, alias);
    await assert.rejects(() => readDeviceEvidenceData(alias, out, current));
    await unlink(alias);
    const hard = resolve(root, "hard.json");
    await link(path, hard);
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
    await unlink(hard);
    const inside = resolve(out, "devices.json");
    await writeFile(inside, JSON.stringify(data), { mode: 0o600 });
    await assert.rejects(() => readDeviceEvidenceData(inside, out, current));
    await save({ ...data, authenticated: true });
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
    const pending = structuredClone(data);
    const firstCleanup = pending.cleanup[0];
    assert.ok(firstCleanup);
    firstCleanup.receipt = {
      operationId: "pending",
      revocationId: "pending",
      state: "pending",
      pendingRecipients: [{ kind: "workspace", id: "workspace" }],
    };
    await save(pending);
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
    await writeFile(path, Buffer.alloc(1048577), { mode: 0o600 });
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
    await writeFile(path, "{", { mode: 0o600 });
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actual runner recovery predicate requires the complete Free set including devices before provider operation", async () => {
  const { current } = await metadataFixture();
  const source = await readFile(new URL("./run-evidence.ts", import.meta.url), "utf8");
  const start = source.indexOf("      const ready ="),
    end = source.indexOf("      if (recovery", start);
  assert.ok(start >= 0 && end > start);
  const ready = new Function(
    "recoveryContext",
    "results",
    "identity",
    "liveRecoveryReady",
    `${source.slice(start, end)}\nreturn ready;`,
  );
  // Independent approved non-recovery Free obligations, not a count assertion.
  const rows = [
    "ticket-grants-revoke",
    "workspace-atomicity",
    "fence-generation",
    "dispatch-safety",
    "approval-reconcile",
    "cloud-local-portability",
    "models-security",
    "public-clients",
    "infrastructure-boundaries",
  ].map((id) => ({ id, outcome: "pass" as const }));
  const check = (items: readonly { id: string; outcome: string }[], target = current) =>
    ready({}, items, { deployments: [target] }, liveRecoveryReady);
  assert.equal(check(rows), true);
  assert.equal(
    check(rows.filter((row) => row.id !== "cloud-local-portability")),
    false,
    "All observed rows may pass while devices are missing",
  );
  assert.equal(check(rows.filter((row) => row.id !== "infrastructure-boundaries")), false);
  assert.equal(
    check(
      rows.map((row) =>
        row.id === "cloud-local-portability" ? { ...row, outcome: "unavailable" } : row,
      ),
    ),
    false,
  );
  const first = rows[0];
  assert.ok(first);
  assert.equal(check([...rows, first]), false);
  assert.equal(
    check([
      ...rows,
      { id: "platform-recovery", outcome: "unavailable" },
      { id: "pi-lifecycle", outcome: "unavailable" },
    ]),
    true,
  );
  const paid: DeploymentIdentity = {
    ...current,
    backend: "cloud-js",
    capabilities: { plan: "paid", loaders: true, containers: false },
  };
  assert.equal(
    check(rows, paid),
    false,
    "A synthetic Paid target still requires its actual tool row; no scope waiver",
  );
  assert.equal(check([...rows, { id: "real-cloud-tools", outcome: "pass" }], paid), true);
});
