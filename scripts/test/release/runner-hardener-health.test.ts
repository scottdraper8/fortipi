import assert from "node:assert/strict";
import test from "node:test";
import {
  assertJobFresh,
  assertNoRunnerFailureAnnotations,
  assertWindowsAgent,
  macosNetworkExtensionActive,
  selectNativeJobWindow,
  windowsAgent,
} from "../../runner-hardener-health.ts";

test("current-job metadata must identify one unfinished job on the actual runner", () => {
  const expected = {
    repository: "owner/repo",
    runId: 19,
    name: "native (macos-15)",
    runnerName: "runner-1",
  };
  const row = {
    id: 7,
    run_id: 19,
    name: expected.name,
    runner_name: expected.runnerName,
    status: "in_progress",
    conclusion: null,
    completed_at: null,
    started_at: "2026-11-22T19:00:00Z",
    check_run_url: "https://api.github.com/repos/owner/repo/check-runs/7",
  };
  const now = Date.parse("2026-11-22T19:00:01Z");
  selectNativeJobWindow({ total_count: 1, jobs: [row] }, expected, now);
  for (const change of [
    { runner_name: undefined },
    { runner_name: "" },
    { runner_name: "runner-2" },
    { conclusion: "failure" },
    { conclusion: undefined },
    { completed_at: "2026-11-22T19:00:01Z" },
    { completed_at: undefined },
    { run_id: 20 },
    { check_run_url: "https://example.com/check-runs/7" },
  ]) {
    assert.throws(() =>
      selectNativeJobWindow({ total_count: 1, jobs: [{ ...row, ...change }] }, expected, now),
    );
  }
  assert.throws(() =>
    selectNativeJobWindow({ total_count: 1, jobs: [row] }, { ...expected, runnerName: "" }, now),
  );
  assert.throws(() => selectNativeJobWindow({ total_count: 2, jobs: [row, row] }, expected, now));
});

test("a successful action cannot hide a reported installer failure", () => {
  assertNoRunnerFailureAnnotations([]);
  assertNoRunnerFailureAnnotations([{ annotation_level: "warning" }]);
  assert.throws(() => assertNoRunnerFailureAnnotations([{ annotation_level: "failure" }]));
  assert.throws(() => assertNoRunnerFailureAnnotations([{ annotation_level: "unknown" }]));
  assert.throws(() =>
    assertNoRunnerFailureAnnotations(Array(100).fill({ annotation_level: "notice" })),
  );
});

test("native health refuses inactive or differently signed macOS extensions", () => {
  const active = "* * D63S9HLM4L io.stepsecurity.harden-runner.ext (1.0) [activated enabled]";
  assert.equal(macosNetworkExtensionActive(active), true);
  for (const incorrect of [
    active.replace("* *", "*"),
    active.replace("D63S9HLM4L", "OTHERTEAM1"),
    active.replace("harden-runner.ext", "other.ext"),
    active.replace("[activated enabled]", "[activated waiting for user]"),
  ])
    assert.equal(macosNetworkExtensionActive(incorrect), false);
});

test("a live Windows PID alone cannot establish matching current-job hardener activity", () => {
  const window = { id: 7, startedAt: 1000, observedAt: 3000 };
  const observation = {
    pid: 42,
    path: "C:\\agent\\agent.exe",
    startedAt: 2000,
    size: windowsAgent.size,
    sha256: windowsAgent.sha256,
  };
  assertWindowsAgent(observation, 42, window);
  for (const change of [
    { pid: 43 },
    { path: "C:\\other\\agent.exe" },
    { startedAt: 999 },
    { startedAt: 3001 },
    { size: windowsAgent.size + 1 },
    { sha256: "0".repeat(64) },
  ])
    assert.throws(() => assertWindowsAgent({ ...observation, ...change }, 42, window));
  for (const timestamp of [999, 3001, Number.NaN]) {
    assert.throws(() => assertJobFresh(timestamp, window));
  }
});
