import assert from "node:assert/strict";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { harness } from "./harness.ts";
import type { StorageGuardProbe } from "./pi-watermark-worker.js";

test("pre-entry Pi watermark preserves prior and competing app/Lifecycle acknowledgments across refusal and reopen", async () => {
  const h = await harness({
    main:
      process.env.FORTIPI_PI_WATERMARK_WORKER ??
      resolve("apps/worker/test/agent/pi-watermark-worker.ts"),
  });
  try {
    const env = await h.server
      .getWorker<{ GUARD_PROBE: DurableObjectNamespace<StorageGuardProbe> }>()
      .getEnv();
    for (const mode of ["entry", "adapter-failure"] as const) {
      const actual = await env.GUARD_PROBE.getByName(mode).characterize(mode);
      assert.equal(
        actual.appRetained,
        true,
        "An acknowledged competing application write must survive",
      );
      assert.equal(actual.wakeRetained, true, "An acknowledged Lifecycle wake must survive");
      assert.deepEqual(actual.retainedDoc, { text: "retained-canary" });
      assert.equal(actual.receipts, 0);
      assert.equal(actual.publications, 0);
      assert.equal(actual.delegates, mode === "entry" ? 0 : 1);
      if (mode === "entry") {
        assert.ok(actual.bytes >= 524288);
        assert.equal(
          actual.markerRefused,
          true,
          "Unwritable hold marker cannot erase earlier identities",
        );
      }
    }
  } finally {
    await h.close();
  }
});
