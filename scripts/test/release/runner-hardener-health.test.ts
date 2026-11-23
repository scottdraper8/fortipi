import assert from "node:assert/strict";
import test from "node:test";
import {
  assertJobFresh,
  assertNoRunnerFailureAnnotations,
  assertWindowsAgent,
  macosNetworkExtensionActive,
  parseWindowsHealthProcess,
  runnerHardenerFailureMessage,
  selectNativeJobWindow,
  windowsAgent,
  windowsHealthCommandFailure,
  windowsHealthQueryProgress,
} from "../../runner-hardener-health.ts";

test("health failure annotations accept exact fixed messages and withhold private suffixes", () => {
  const generic = "Runner hardener health failed; details withheld";
  const canary = "private-token-path-url-child-output-canary";
  for (const message of [
    "Runner hardener observation is outside the current job window",
    "Runner hardener PID changed",
    "Runner hardener executable identity differs",
    "Runner hardener bytes differ from the reviewed vendor archive",
    "Runner annotations are incomplete",
    "Runner reported a failure annotation",
    "Current-job read token is required",
    "Runner hardener verification unavailable (job-metadata)",
    "Runner hardener verification unavailable (runner-annotations)",
    "Runner hardener verification unavailable (reported-runner-failure-or-incomplete-annotations)",
    "Unable to verify current-job hardener file metadata",
    "Unable to verify the macOS StepSecurity network extension",
    "macOS StepSecurity network extension is not activated and enabled",
    "The reviewed Windows hardener supports x64 only",
    "Unable to read the owned Windows hardener PID",
    "Invalid owned hardener PID",
    "Unable to verify reviewed Windows hardener bytes",
    "Unable to verify the owned Windows hardener process",
    "Unable to verify the owned Windows hardener process (command-stopped)",
    "Unable to verify the owned Windows hardener process (command-launch)",
    "Unable to verify the owned Windows hardener process (command-unavailable)",
    "Unable to verify the owned Windows hardener process (command-exit)",
    "Unable to verify the owned Windows hardener process (command-output-limit)",
    "Unable to verify the owned Windows hardener process (json-parse)",
    "Unable to verify the owned Windows hardener process (json-shape)",
    "Runner reached deliberately unallowed destination; block enforcement is required",
  ]) {
    assert.equal(runnerHardenerFailureMessage(new Error(message)), message);
    for (const unknown of [
      `${message}: ${canary}`,
      `${canary}: ${message}`,
      `${message}\n::error::${canary}`,
    ])
      assert.equal(runnerHardenerFailureMessage(new Error(unknown)), generic);
  }
  for (const value of [
    canary,
    "",
    undefined,
    null,
    42,
    true,
    Symbol(canary),
    { message: { private: canary } },
  ])
    assert.equal(runnerHardenerFailureMessage(value), generic);
  assert.equal(runnerHardenerFailureMessage(new Error(canary)), generic);
});

test("health annotation fallback never invokes message accessors or string coercion", () => {
  let accesses = 0;
  const error = Object.defineProperty({}, "message", {
    get() {
      accesses++;
      throw Error("private");
    },
  });
  assert.equal(
    runnerHardenerFailureMessage(error),
    "Runner hardener health failed; details withheld",
  );
  const message = {
    toString() {
      accesses++;
      return "Runner hardener PID changed";
    },
  };
  assert.equal(
    runnerHardenerFailureMessage({ message }),
    "Runner hardener health failed; details withheld",
  );
  assert.equal(accesses, 0);
});

test("Windows health command diagnostics separate output limits, stopping, launch and exit without raw errors", () => {
  const canary = "private-stderr-path-token-canary";
  for (const [error, expected] of [
    [
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM" },
      "command-output-limit",
    ],
    [{ code: "ENOENT" }, "command-launch"],
    [{ code: "EACCES" }, "command-launch"],
    [{ code: "EPERM" }, "command-launch"],
    [{ killed: true }, "command-stopped"],
    [{ signal: "SIGTERM", code: 1 }, "command-stopped"],
    [{ code: 1 }, "command-exit"],
    [{ code: 4294967295 }, "command-exit"],
    [{ code: 0 }, "command-unavailable"],
    [{ code: canary, message: canary, stdout: canary, stderr: canary }, "command-unavailable"],
    [{ cause: { code: "ENOENT" }, message: canary }, "command-unavailable"],
    [Object.create({ code: "ENOENT", killed: true, signal: "SIGTERM" }), "command-unavailable"],
    [canary, "command-unavailable"],
    [null, "command-unavailable"],
  ] as const)
    assert.equal(windowsHealthCommandFailure(error), expected);
  let accesses = 0;
  const error = Object.defineProperties(
    {},
    Object.fromEntries(
      ["code", "killed", "signal", "message", "cause", "stack", "stderr"].map((key) => [
        key,
        {
          get() {
            accesses++;
            throw Error(canary);
          },
        },
      ]),
    ),
  );
  assert.equal(windowsHealthCommandFailure(error), "command-unavailable");
  assert.equal(accesses, 0);
});

test("Windows health query progress exposes only bounded exact markers without private error access", () => {
  const canary = "private-stderr-path-token-canary";
  const marker = "fortipi-windows-health:entry";
  for (const stage of [
    "entry",
    "lookup-start",
    "lookup-complete",
    "path-start",
    "path-complete",
    "time-start",
    "time-complete",
    "serialization-start",
    "serialization-complete",
    "disposal-start",
    "disposal-complete",
  ])
    assert.equal(windowsHealthQueryProgress({ stderr: `fortipi-windows-health:${stage}` }), stage);
  assert.equal(
    windowsHealthQueryProgress({
      stderr: `${marker}\r\nfortipi-windows-health:lookup-start\r\n${canary}\r\n`,
    }),
    "lookup-start",
  );
  assert.equal(windowsHealthQueryProgress({ stderr: `${marker}\n::error::${canary}` }), "entry");
  assert.equal(
    windowsHealthQueryProgress({
      stderr: "fortipi-windows-health:serialization-complete\nfortipi-windows-health:lookup-start",
    }),
    "lookup-start",
  );
  for (const stderr of [
    "",
    canary,
    `${canary}${marker}`,
    `${marker} ${canary}`,
    `${marker}\r${canary}`,
    ` ${marker}`,
    `${marker}\r`,
    "fortipi-windows-health:unknown",
    "fortipi-windows-health:lookup-",
    Buffer.from(marker),
    null,
    42,
  ])
    assert.equal(windowsHealthQueryProgress({ stderr }), "unobserved");
  for (const error of [
    null,
    undefined,
    canary,
    Buffer.from(marker),
    {},
    Object.create({ stderr: marker }),
  ])
    assert.equal(windowsHealthQueryProgress(error), "unobserved");
  let accesses = 0;
  const failAccess = () => {
    accesses++;
    throw Error(canary);
  };
  assert.equal(
    windowsHealthQueryProgress(Object.defineProperty({}, "stderr", { get: failAccess })),
    "unobserved",
  );
  assert.equal(windowsHealthQueryProgress({ stderr: { toString: failAccess } }), "unobserved");
  const error = Object.defineProperties(
    { stderr: marker },
    Object.fromEntries(
      ["message", "stdout", "stack", "cause"].map((key) => [key, { get: failAccess }]),
    ),
  );
  assert.equal(windowsHealthQueryProgress(error), "entry");
  assert.equal(accesses, 0);
  const bounded = `${marker}\n${"x".repeat(16384 - Buffer.byteLength(marker) - 1)}`;
  assert.equal(windowsHealthQueryProgress({ stderr: bounded }), "entry");
  assert.equal(windowsHealthQueryProgress({ stderr: `${bounded}x` }), "unobserved");
  assert.equal(
    windowsHealthQueryProgress({ stderr: `${marker}\n${"é".repeat(8192)}` }),
    "unobserved",
  );
});

test("Windows health process parsing reports fixed JSON syntax or shape failures without output", () => {
  const canary = "private-process-output-path-canary";
  assert.throws(
    () => parseWindowsHealthProcess(`{${canary}`),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Unable to verify the owned Windows hardener process (json-parse)",
      );
      assert.equal(runnerHardenerFailureMessage(error), error.message);
      return true;
    },
  );
  for (const value of [
    null,
    [],
    true,
    { private: canary },
    { pid: "42", path: canary, startedAt: canary },
  ])
    assert.throws(
      () => parseWindowsHealthProcess(JSON.stringify(value)),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Unable to verify the owned Windows hardener process (json-shape)",
        );
        assert.equal(runnerHardenerFailureMessage(error), error.message);
        return true;
      },
    );
  const observation = { pid: 42, path: "C:\\agent\\agent.exe", startedAt: "2026-11-22T19:00:00Z" };
  assert.deepEqual(parseWindowsHealthProcess(JSON.stringify(observation)), observation);
});

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
