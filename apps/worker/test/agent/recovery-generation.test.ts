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
  }, async (t) => {
    let phase = "fixture";
    let observed: State | undefined, initialId: string | undefined;
    const aborted = () =>
      t.diagnostic(
        JSON.stringify({
          diagnostic: "recovery-generation-phase",
          mode,
          phase,
          event: "aborted",
          stateSeen: observed !== undefined,
          lastRunning: observed?.state?.running === true,
          lastArmPending: observed?.state?.armPending === true,
          lastSuccessor:
            initialId !== undefined &&
            observed?.state?.id !== undefined &&
            observed.state.id !== initialId,
          lastSecondDrain: observed?.calls === 2,
          lastRowsBounded: Array.isArray(observed?.jobs) && observed.jobs.length <= 2,
        }),
      );
    t.signal.addEventListener("abort", aborted, { once: true });
    t.after(() => t.signal.removeEventListener("abort", aborted));
    const h = await harness();
    const probe = h.env.AGENT_SESSIONS.getByName(`recovery-${mode.replaceAll(" ", "-")}`);
    const state = async () => {
      const value = JSON.parse(await probe.repairProbeJson()) as State;
      observed = value;
      return value;
    };
    try {
      phase = "begin";
      await probe.beginRepairProbe();
      phase = "initial";
      const old = probe.driveRepairProbe();
      const initial = await eventually(state, (s) => s.calls === 1 && s.state.running);
      initialId = initial.state.id;
      phase = "takeover-delay";
      if (mode === "hung takeover") await pause(15100);
      else await probe.supersedeRepairProbe();
      phase = "takeover-alarm";
      const takeover = probe.driveRepairProbe();
      if (mode === "hung takeover") await takeover;
      phase = "successor";
      const latest = await eventually(
        state,
        (s) => s.state.id !== initial.state.id && !s.state.armPending,
      );
      phase = "second-drain";
      const newer = mode === "hung takeover" ? probe.driveRepairProbe() : takeover;
      await eventually(state, (s) => s.calls === 2);
      phase = "release-old";
      await probe.releaseRepairProbe("old");
      await old;
      const held = await state();
      assert.equal(held.state.id, latest.state.id);
      assert.ok(
        held.jobs.some((job) => job.id === latest.state.id),
        "Old completion must not delete a newer durable wake",
      );
      assert.ok(held.jobs.length <= 2);
      phase = "release-new";
      await probe.releaseRepairProbe("new");
      await newer;
      const resumed = await state();
      assert.equal(resumed.state.running, false);
      assert.equal(resumed.state.armPending, false);
      assert.ok(resumed.jobs.find((job) => job.id === latest.state.id)!.time > Date.now());
      phase = "coalesce";
      for (let i = 0; i < 20; i++) await probe.supersedeRepairProbe();
      const coalesced = await state();
      assert.equal(coalesced.state.generation, latest.state.generation);
      assert.equal(coalesced.jobs.length, 1);
    } finally {
      phase = "close";
      await probe.releaseRepairProbe("old");
      await probe.releaseRepairProbe("new");
      await h.close();
    }
  });
}
