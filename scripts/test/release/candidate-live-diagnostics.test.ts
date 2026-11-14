import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { observeCandidateDiagnostics } from "../../build-workspaces.ts";

const host = JSON.stringify({
  diagnostic: "source-test-host",
  node: "26.13.1",
  availableParallelism: 4,
  files: 1,
});
const phase = `# ${JSON.stringify({
  diagnostic: "source-recovery-phase",
  event: "enter",
  phase: "after-submit.restart",
  elapsedMs: 100,
  phaseMs: 0,
})}`;

test("candidate stderr diagnostics arrive before child completion while original capture and failure survive", {
  timeout: 5000,
}, async () => {
  const stdout = `${host}\nsynthetic-private-stdout\n`;
  const stderr = `synthetic-private-stderr\n${host}\n${phase}`;
  const pending = promisify(execFile)(
    process.execPath,
    [
      "-e",
      `
    process.stdin.once('data', () => { process.stderr.write(${JSON.stringify(phase)}); process.exitCode = 7; process.stdin.destroy(); });
    process.stdout.write(${JSON.stringify(stdout)});
    process.stderr.write('synthetic-private-stderr\\n' + ${JSON.stringify(host.slice(0, 21))});
    setTimeout(() => process.stderr.write(${JSON.stringify(`${host.slice(21)}\n`)}), 10);
  `,
    ],
    { env: {}, timeout: 3000, maxBuffer: 4096 },
  );
  const result = pending.then(
    () => assert.fail("Expected original child failure"),
    (error: unknown) => error,
  );
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  const forwarded: string[] = [];
  let sinkFailures = 0;
  let acceptLive = () => {};
  const live = new Promise<void>((accept) => {
    acceptLive = accept;
  });
  assert.ok(pending.child.stderr && pending.child.stdin);
  observeCandidateDiagnostics(pending.child.stderr, (line) => {
    forwarded.push(line);
    acceptLive();
    if (line === `${phase}\n`) {
      sinkFailures++;
      throw new Error("synthetic-private-canary");
    }
  });
  await live;
  assert.equal(settled, false, "The child must still be waiting for the parent");
  assert.deepEqual(forwarded, [`${host}\n`]);
  pending.child.stdin.end("finish");
  const error = (await result) as { code: number; stdout: string; stderr: string };
  assert.equal(error.code, 7);
  assert.equal(error.stdout, stdout);
  assert.equal(error.stderr, stderr);
  assert.deepEqual(forwarded, [`${host}\n`, `${phase}\n`]);
  assert.equal(sinkFailures, 1, "A diagnostic sink failure cannot replace the child failure");
});

test("candidate diagnostic lines resynchronize only after newline and flush only valid EOF records", async () => {
  const stream = new PassThrough(),
    forwarded: string[] = [];
  observeCandidateDiagnostics(stream, (line) => forwarded.push(line));
  stream.write(`synthetic-private-canary ${host}\n`);
  stream.write(`{"diagnostic":"synthetic-private-canary",${host.slice(1)}\n`);
  stream.write(`${"x".repeat(1_000_000)}${host}\n`);
  stream.write(host.slice(0, 20));
  stream.write(`${host.slice(20)}\r`);
  assert.deepEqual(forwarded, []);
  stream.write("\n");
  assert.deepEqual(forwarded, [`${host}\n`]);
  const ended = once(stream, "end");
  stream.end(phase);
  await ended;
  assert.deepEqual(forwarded, [`${host}\n`, `${phase}\n`]);
  for (const tail of [
    Buffer.from(host.slice(0, -1)),
    Buffer.concat([Buffer.from(host), Buffer.from([0xc3])]),
  ]) {
    const incomplete = new PassThrough(),
      out: string[] = [];
    observeCandidateDiagnostics(incomplete, (line) => out.push(line));
    const done = once(incomplete, "end");
    incomplete.end(tail);
    await done;
    assert.deepEqual(out, []);
  }
  const closed = new PassThrough(),
    out: string[] = [];
  observeCandidateDiagnostics(closed, (line) => out.push(line));
  closed.write(host);
  const done = once(closed, "close");
  closed.destroy();
  await done;
  assert.deepEqual(out, [], "An interrupted unterminated record is discarded");
});

test("diagnostic observation preserves execFile output bounds and timeout failures", {
  timeout: 5000,
}, async () => {
  for (const mode of ["buffer", "timeout"] as const) {
    const script =
      mode === "buffer"
        ? "process.stderr.write('x'.repeat(10000));"
        : "setInterval(() => {}, 1000);";
    const pending = promisify(execFile)(process.execPath, ["-e", script], {
      env: {},
      maxBuffer: 256,
      timeout: mode === "buffer" ? 3000 : 300,
    });
    assert.ok(pending.child.stderr);
    const forwarded: string[] = [];
    observeCandidateDiagnostics(pending.child.stderr, (line) => forwarded.push(line));
    await assert.rejects(pending, (error: unknown) => {
      const e = error as { code: string; killed: boolean; signal: string; stderr: string };
      if (mode === "buffer") {
        assert.equal(e.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
        assert.equal(e.stderr.length, 256);
      } else {
        assert.equal(e.killed, true);
        assert.equal(e.signal, "SIGTERM");
      }
      return true;
    });
    assert.deepEqual(forwarded, []);
  }
});
