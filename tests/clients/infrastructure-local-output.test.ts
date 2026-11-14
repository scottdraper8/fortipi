import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Ledger } from "../../packages/fortipi-executor/dist/ledger.js";
import {
  infrastructureLocalOutputLimitations,
  runInfrastructureLocalOutput,
} from "./infrastructure-local-output.ts";

test("real local stdout crosses the output cap, persists bounded files/tail and survives the same SQLite identity reopen", async (t) => {
  const value = await runInfrastructureLocalOutput();
  assert.deepEqual(Object.keys(value).sort(), [
    "above",
    "at",
    "below",
    "bodyHashAfterReopen",
    "bodyHashBefore",
    "limits",
  ]);
  assert.deepEqual(value.limits, {
    outputBytesPerJob: 256,
    inlineTailBytes: 32,
    artifactBytes: 256,
  });
  // Independent requirements: retain every byte below/at, only 256 above;
  // tail is the last 32 ASCII bytes and retained artifacts contain all 256.
  assert.deepEqual(value.below, {
    producedBytes: 255,
    retainedBytes: 255,
    tailBytes: 32,
    artifactBytes: 255,
    truncated: false,
  });
  assert.deepEqual(value.at, {
    producedBytes: 256,
    retainedBytes: 256,
    tailBytes: 32,
    artifactBytes: 256,
    truncated: false,
  });
  assert.deepEqual(value.above, {
    producedBytes: 257,
    retainedBytes: 256,
    tailBytes: 32,
    artifactBytes: 256,
    truncated: true,
  });
  assert.match(value.bodyHashBefore, /^[a-f0-9]{64}$/);
  assert.equal(value.bodyHashAfterReopen, value.bodyHashBefore);
  assert.match(infrastructureLocalOutputLimitations.join(" "), /no live account|without daemon/);
  t.diagnostic(JSON.stringify(value));
});

test("changing an actual retained artifact at reopen refuses facts and cleans up the private component directory", async (t) => {
  const original = Ledger.open;
  let changedDirectory: string | undefined;
  let changed = 0;
  t.mock.method(Ledger, "open", async (...args: Parameters<typeof Ledger.open>) => {
    const ledger = await original.apply(Ledger, args);
    {
      // Ordinary open never initializes; provisioning has its private creation path.
      changedDirectory = args[0];
      const artifacts = await readdir(join(args[0], "artifacts"));
      const first = artifacts[0];
      assert.ok(first);
      const path = join(args[0], "artifacts", first);
      const before = await readFile(path);
      assert.ok(before.length > 0);
      const file = await open(path, "r+");
      try {
        await file.write(Buffer.from([(before[0] ?? 0) ^ 0xff]), 0, 1, 0);
        await file.sync();
      } finally {
        await file.close();
      }
      assert.notEqual(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
        createHash("sha256").update(before).digest("hex"),
      );
      changed++;
    }
    return ledger;
  });
  await assert.rejects(runInfrastructureLocalOutput(), /Local output artifact identity changed/);
  assert.equal(changed, 1);
  assert.ok(changedDirectory);
  await assert.rejects(lstat(changedDirectory), { code: "ENOENT" });
});
