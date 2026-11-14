import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./harness.ts";

type Proof = {
  mode: string;
  failure: string;
  competing: string;
  publications: number;
  baselineBytes: number;
  afterBytes: number;
  retainedCanary: boolean;
  appRetained: boolean;
  wakeRetained: boolean;
};
for (const mode of ["solo", "app", "lifecycle"] as const)
  test(`REJECTED outer rollback guard characterizes competing ${mode} acknowledgment loss`, {
    timeout: 15000,
  }, async () => {
    const h = await harness();
    try {
      const result = JSON.parse(
        await h.env.GUARD_PROBE.getByName(`guard-${mode}`).characterize(mode),
      ) as Proof;
      console.log(JSON.stringify(result));
      assert.match(result.failure, /Guarded SQL storage ceiling reached/);
      assert.equal(result.publications, 0, "Rejected Pi transaction must publish nothing");
      assert.equal(result.retainedCanary, true);
      assert.ok(result.afterBytes <= 524288);
      if (mode === "app") {
        assert.equal(result.competing, "acknowledged");
        assert.equal(
          result.appRetained,
          false,
          "This rejected prototype loses acknowledged application writes",
        );
      }
      if (mode === "lifecycle") {
        assert.equal(result.competing, "acknowledged");
        assert.equal(
          result.wakeRetained,
          false,
          "This rejected prototype loses acknowledged Lifecycle wakes",
        );
      }
    } finally {
      await h.close();
    }
  });
