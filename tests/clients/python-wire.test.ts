import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { test } from "node:test";
import { type Fault, primary, pythonPeer, secondary } from "./fixtures/python-wire-peer.ts";

const root = resolve(import.meta.dirname, "../..");
function child(endpoint: string, token = primary, allowHttp = true) {
  const process = spawn(
    "python3",
    [
      "-I",
      "-B",
      resolve(root, "examples/python-client/client.py"),
      "--endpoint",
      endpoint,
      ...(allowHttp ? ["--allow-loopback-http"] : []),
      "--timeout",
      "3",
    ],
    {
      cwd: root,
      // Only this role's synthetic credential. No ambient auth/proxy/Python configuration.
      env: {
        PATH: globalThis.process.env.PATH ?? "",
        LANG: "C.UTF-8",
        FORTIPI_CLIENT_TOKEN: token,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines: Record<string, unknown>[] = [];
  const pending: { resolve(value: Record<string, unknown>): void; reject(error: Error): void }[] =
    [];
  let output = "",
    diagnostics = "",
    total = 0;
  process.stdout.setEncoding("utf8");
  process.stderr.setEncoding("utf8");
  process.stdout.on("data", (bytes: string) => {
    total += Buffer.byteLength(bytes);
    assert.ok(total <= 65536, "example evidence must be bounded and redacted");
    output += bytes;
    for (;;) {
      const end = output.indexOf("\n");
      if (end < 0) break;
      const parsed = JSON.parse(output.slice(0, end)) as Record<string, unknown>;
      output = output.slice(end + 1);
      const waiter = pending.shift();
      if (waiter) waiter.resolve(parsed);
      else lines.push(parsed);
    }
  });
  process.stderr.on("data", (bytes: string) => {
    diagnostics += bytes;
    assert.ok(diagnostics.length <= 4096);
  });
  process.on("error", (error) => {
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });
  const exited = new Promise<number | null>((accept) => process.once("close", accept));
  const timer = setTimeout(() => process.kill("SIGKILL"), 15000);
  process.once("close", () => {
    clearTimeout(timer);
    for (const waiter of pending.splice(0))
      waiter.reject(new Error("Python exited without metadata"));
  });
  process.stdin.on("error", () => {
    for (const waiter of pending.splice(0)) waiter.reject(new Error("Python input closed"));
  });
  const next = () =>
    lines.length
      ? Promise.resolve(lines.shift() as Record<string, unknown>)
      : new Promise<Record<string, unknown>>((resolve, reject) =>
          pending.push({ resolve, reject }),
        );
  return {
    async command(value: object) {
      const result = next();
      process.stdin.write(`${JSON.stringify(value)}\n`);
      return result;
    },
    next,
    async finish(expected = 0) {
      process.stdin.end();
      assert.equal(await exited, expected);
      assert.equal(diagnostics, "", "no request/body/traceback diagnostics");
      assert.equal(output, "");
    },
    async dispose() {
      process.stdin.end();
      if (process.exitCode === null) process.kill("SIGKILL");
      await exited;
    },
  };
}

async function prepared(endpoint: string) {
  const python = child(endpoint);
  try {
    assert.deepEqual(await python.command({ op: "discover" }), {
      ok: true,
      protocolVersion: "1.0",
      schemaVersion: "1.0.0",
      schemas: 15,
    });
    return python;
  } catch (error) {
    await python.dispose();
    throw error;
  }
}

test("actual stdlib Python follows canonical HTTP/ticket/socket wire, fragmented Unicode, ping/pong and committed offline resume", {
  timeout: 20000,
}, async (t) => {
  const peer = await pythonPeer();
  t.after(() => peer.close());
  const a = await prepared(peer.endpoint);
  const b = child(peer.endpoint, secondary);
  try {
    assert.deepEqual(await a.command({ op: "agents" }), {
      ok: true,
      agentIds: ["agent-A"],
      nextPageToken: null,
    });
    assert.deepEqual(await a.command({ op: "conversations", agentId: "agent-A" }), {
      ok: true,
      conversationIds: [],
      nextPageToken: null,
    });
    const create = { op: "create", agentId: "agent-A", requestId: "create-A" };
    assert.deepEqual(await a.command(create), await a.command(create));
    assert.deepEqual(await a.command({ op: "snapshot", conversationId: "conversation-A" }), {
      ok: true,
      conversationId: "conversation-A",
      lastEventSeq: 1,
      messages: 0,
    });
    assert.deepEqual(
      await a.command({ op: "subscribe", agentId: "agent-A", conversationId: "conversation-A" }),
      { ok: true, cursor: 1, replayed: 0 },
    );
    const submit = {
      op: "send",
      conversationId: "conversation-A",
      clientRequestId: "message-A",
      content: "synthetic-content",
    };
    const receipt = await a.command(submit);
    assert.deepEqual(await a.command(submit), receipt);
    assert.equal(receipt.taskId, "task-A");
    assert.deepEqual(await a.command({ op: "next" }), {
      ok: true,
      cursor: 1,
      closed: false,
      eventType: "future.transient",
      durability: "volatile",
    });
    assert.equal((await a.command({ op: "next" })).cursor, 2);
    assert.deepEqual(await a.command({ op: "next" }), {
      ok: true,
      cursor: 3,
      closed: false,
      eventType: "future.persisted",
      durability: "durable",
    });
    assert.deepEqual(await a.command({ op: "completion", taskId: "task-A" }), {
      ok: true,
      cursor: 4,
      closed: false,
      eventType: "task.completed",
      durability: "durable",
    });
    assert.deepEqual(await a.command({ op: "disconnect" }), { ok: true, cursor: 4 });
    assert.equal((await b.command({ ...submit, clientRequestId: "message-B" })).taskId, "task-B");
    assert.deepEqual(await a.command({ op: "replay" }), {
      ok: true,
      after: 4,
      nextAfter: 6,
      events: 2,
      applied: false,
      cursor: 4,
    });
    assert.deepEqual(
      await a.command({
        op: "subscribe",
        agentId: "agent-A",
        conversationId: "conversation-A",
        resume: true,
      }),
      { ok: true, cursor: 6, replayed: 2 },
    );
    assert.equal(
      (await a.command({ op: "next" })).cursor,
      6,
      "volatile traffic cannot move the resumed cursor",
    );
    assert.deepEqual(await a.command({ op: "next" }), { ok: true, cursor: 6, closed: true });
    await a.finish();
    await b.finish();
    assert.deepEqual(peer.failures, []);
    assert.deepEqual(peer.observations.subscribes, [1, 6]);
    assert.equal(peer.observations.pongs, 1);
    assert.ok(peer.observations.closes >= 1);
    assert.equal(peer.observations.sends.length, 3);
    assert.deepEqual(peer.observations.sends[0], peer.observations.sends[1]);
    assert.ok(peer.observations.masks.size >= 4);
  } finally {
    await a.dispose();
    await b.dispose();
    await peer.close();
  }
});

test("actual Python refuses wrong accept, oversized controls/messages, truncation, malformed known events and invalid UTF8; restored peer works", {
  timeout: 30000,
}, async (t) => {
  for (const fault of [
    "accept",
    "control",
    "message",
    "truncated",
    "known",
    "utf8",
    "none",
  ] satisfies Fault[]) {
    const peer = await pythonPeer();
    t.after(() => peer.close());
    peer.setFault(fault);
    const python = await prepared(peer.endpoint);
    try {
      const subscribed = await python.command({
        op: "subscribe",
        agentId: "agent-A",
        conversationId: "conversation-A",
      });
      if (fault === "accept") {
        assert.deepEqual(subscribed, { ok: false, error: "handshake_failed" });
        assert.equal(peer.observations.upgrades, 1);
        assert.equal(peer.observations.subscribes.length, 0);
        await python.finish(1);
      } else {
        assert.equal(subscribed.ok, true);
        const next = await python.command({ op: "next" });
        const expected = {
          control: "invalid_control_frame",
          message: "frame_too_large",
          truncated: "truncated_transport",
          known: "invalid_wire",
          utf8: "invalid_json",
        };
        if (fault === "none") {
          assert.equal(next.ok, true);
          assert.equal(next.cursor, 1);
          await python.finish();
        } else {
          assert.deepEqual(next, { ok: false, error: expected[fault] });
          await python.finish(1);
        }
      }
      assert.deepEqual(peer.failures, []);
    } finally {
      await python.dispose();
      await peer.close();
    }
  }
});

test("HTTP is opt-in exact loopback and importing the example neither reads credentials nor starts I/O", {
  timeout: 5000,
}, async () => {
  for (const [endpoint, allow] of [
    ["http://127.0.0.1:1", false],
    ["http://example.invalid", true],
  ] as const) {
    const python = child(endpoint, primary, allow);
    try {
      assert.deepEqual(await python.next(), { ok: false, error: "tls_required" });
      await python.finish(1);
    } finally {
      await python.dispose();
    }
  }
  const imported = spawn(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      "import importlib.util,sys; assert sys.version_info[:3]==(3,15,2); spec=importlib.util.spec_from_file_location('fortipi_example',sys.argv[1]); module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; spec.loader.exec_module(module); print('import-safe')",
      resolve(root, "examples/python-client/client.py"),
    ],
    { env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    error = "";
  imported.stdout.on("data", (b: Buffer) => {
    output += b.toString();
  });
  imported.stderr.on("data", (b: Buffer) => {
    error += b.toString();
  });
  assert.deepEqual(await once(imported, "exit"), [0, null]);
  assert.equal(error, "");
  assert.equal(output, "import-safe\n");
});
