import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  observeRecoveryInspection,
  recoveryInspectionLine,
  recoveryInspectionRecord,
} from "../../../apps/worker/test/agent/recovery-inspection-observation.ts";
import { forwardRecoveryInspection } from "../../../apps/worker/test/integration/runtime.ts";

test("recovery inspection records contain only closed fixed phase and return facts", () => {
  const line = recoveryInspectionLine("state-pi-open", "enter");
  assert.equal(
    line,
    '{"diagnostic":"recovery-inspection","phase":"state-pi-open","event":"enter"}',
  );
  assert.equal(recoveryInspectionRecord(line), line);
  const canary = "private-canary-path-payload-credential";
  let accesses = 0;
  const hostile = {
    get phase() {
      accesses++;
      throw new Error(canary);
    },
    toString() {
      accesses++;
      return canary;
    },
  };
  for (const value of [hostile, new String("state-pi-open"), null, 0, canary]) {
    assert.equal(recoveryInspectionLine(value, "enter"), null);
    assert.equal(recoveryInspectionLine("state-pi-open", value), null);
    assert.equal(recoveryInspectionRecord(value), null);
  }
  assert.equal(accesses, 0);
  for (const invalid of [
    `${line} `,
    ` ${line}`,
    `${line}\n`,
    JSON.stringify({ ...JSON.parse(line!), payload: canary }),
    line!.replace("state-pi-open", canary),
    line!.replace('"enter"', '"throw"'),
    line!.replace('"event":"enter"', '"event":"enter","event":"enter"'),
    line!.replace('"enter"', "false"),
    line!.replace('"enter"', "1"),
    "[1,2,3]",
    "x".repeat(130),
  ])
    assert.equal(recoveryInspectionRecord(invalid), null);
  assert.doesNotThrow(() =>
    observeRecoveryInspection("pi-start", "exit", () => {
      throw new Error(canary);
    }),
  );
  const phases = [
    "state-fetch",
    "pi-start",
    "host-start",
    "state-handler",
    "state-admissions",
    "state-creations",
    "state-admission-intents",
    "state-pi-open",
    "state-conversation-scan",
    "state-response",
  ];
  for (const phase of phases)
    for (const event of ["enter", "exit"]) {
      const record = recoveryInspectionLine(phase, event)!;
      assert.equal(recoveryInspectionRecord(record), record);
      assert.ok(Buffer.byteLength(`${record}\n`) <= 128);
    }
});

test("recovery inspection forwarding requires complete owned-child records and contains sink failures", () => {
  const input = new PassThrough();
  let current = true;
  const output: string[] = [];
  forwardRecoveryInspection(
    input,
    () => current,
    (line) => output.push(line),
  );
  const first = recoveryInspectionLine("pi-start", "enter")!;
  const second = recoveryInspectionLine("state-conversation-scan", "exit")!;
  input.write(first.slice(0, 17));
  assert.deepEqual(output, []);
  input.write(`${first.slice(17)}\r\n`);
  input.write(`private-canary\n${"x".repeat(400)}\n`);
  input.write(`${first.slice(0, -1)},"payload":"private-canary"}\n`);
  input.write(`${second}\n`);
  current = false;
  input.write(`${first}\n`);
  current = true;
  input.end(second);
  assert.deepEqual(output, [`${first}\n`, `${second}\n`]);
  const throwing = new PassThrough();
  let calls = 0;
  forwardRecoveryInspection(
    throwing,
    () => true,
    () => {
      calls++;
      throw new Error("private-canary");
    },
  );
  assert.doesNotThrow(() => throwing.end(`${first}\n${second}\n`));
  assert.equal(calls, 2);
});
