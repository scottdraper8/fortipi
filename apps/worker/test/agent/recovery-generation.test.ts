import assert from "node:assert/strict";
import test from "node:test";
import { eventually, harness, pause } from "./harness.ts";

interface State {
  calls: number;
  state: { id: string; generation: number; running: boolean; armPending: boolean };
  jobs: { id: string; time: number }[];
}
for (const mode of ["supersession", "hung takeover"] as const) {
  test(`production Recovery ${mode} preserves distinct successor and bounded rows`, {
    timeout: 25000,
  }, async () => {
    const h = await harness();
    const probe = h.env.AGENT_SESSIONS.getByName(`recovery-${mode.replaceAll(" ", "-")}`);
    const state = async () => JSON.parse(await probe.repairProbeJson()) as State;
    try {
      await probe.beginRepairProbe();
      const old = probe.driveRepairProbe();
      const initial = await eventually(state, (s) => s.calls === 1 && s.state.running);
      if (mode === "hung takeover") await pause(15100);
      else await probe.supersedeRepairProbe();
      const takeover = probe.driveRepairProbe();
      if (mode === "hung takeover") await takeover;
      const latest = await eventually(
        state,
        (s) => s.state.id !== initial.state.id && !s.state.armPending,
      );
      const newer = mode === "hung takeover" ? probe.driveRepairProbe() : takeover;
      await eventually(state, (s) => s.calls === 2);
      await probe.releaseRepairProbe("old");
      await old;
      const held = await state();
      assert.equal(held.state.id, latest.state.id);
      assert.ok(
        held.jobs.some((job) => job.id === latest.state.id),
        "Old completion must not delete a newer durable wake",
      );
      assert.ok(held.jobs.length <= 2);
      await probe.releaseRepairProbe("new");
      await newer;
      const resumed = await state();
      assert.equal(resumed.state.running, false);
      assert.equal(resumed.state.armPending, false);
      assert.ok(resumed.jobs.find((job) => job.id === latest.state.id)!.time > Date.now());
      for (let i = 0; i < 20; i++) await probe.supersedeRepairProbe();
      const coalesced = await state();
      assert.equal(coalesced.state.generation, latest.state.generation);
      assert.equal(coalesced.jobs.length, 1);
    } finally {
      await probe.releaseRepairProbe("old");
      await probe.releaseRepairProbe("new");
      await h.close();
    }
  });
}
