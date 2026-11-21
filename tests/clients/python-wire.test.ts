import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import { type Fault, primary, pythonPeer, secondary } from "./fixtures/python-wire-peer.ts";

const root = resolve(import.meta.dirname, "../..");

test("Python drains paginated subscribe ACK through its fixed barrier before live events and preserves a failed handler cursor", {
  timeout: 20000,
}, async (t) => {
  // Public TCP protocol peer, not a provider/runtime/recovery fixture. Reuse the
  // canonical discovery documents and ticket/snapshot wire from the existing peer.
  // Oracle: addendum §4 orders committed events; AgentSession subscribes live at
  // page.through, and Store.replay caps each HTTP page at the requested through.
  for (const failHandler of [false, true]) {
    await t.test(failHandler ? "handler failure" : "all sequences once", async () => {
      const peer = await pythonPeer();
      const sockets = new Set<Socket>();
      const failures: unknown[] = [];
      const pages: { after: number; through: number | null; nextAfter: number }[] = [];
      let upgrades = 0,
        last = 1;
      const event = (seq: number) => ({
        protocolVersion: "1.0",
        schemaVersion: "1.0.0",
        deploymentId: "deployment-A",
        conversationId: "conversation-A",
        eventId: `ack-event-${seq}`,
        timestamp: 1,
        durability: "durable",
        eventSeq: seq,
        type: "future.persisted",
        payload: {},
      });
      const page = (after: number, through: number) => {
        const nextAfter = Math.min(after + 2, through);
        return {
          after,
          through,
          lastEventSeq: last,
          nextAfter,
          hasMore: nextAfter < through,
          retainedFloor: 0,
          events: Array.from({ length: nextAfter - after }, (_, i) => event(after + i + 1)),
        };
      };
      const send = (socket: Socket, value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value));
        assert.ok(bytes.length < 65536);
        const header =
          bytes.length < 126
            ? Buffer.from([0x81, bytes.length])
            : Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255]);
        socket.write(Buffer.concat([header, bytes]));
      };
      const server = createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url ?? "/", peer.endpoint);
          if (url.pathname.endsWith("/events")) {
            assert.equal(request.headers.authorization, `Bearer ${primary}`);
            assert.equal(url.searchParams.get("limit"), "100");
            const after = Number(url.searchParams.get("after"));
            const through = url.searchParams.has("through")
              ? Number(url.searchParams.get("through"))
              : null;
            const receipt = page(after, through ?? last);
            pages.push({ after, through, nextAfter: receipt.nextAfter });
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(receipt));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            assert.ok(size <= 8192);
            chunks.push(Buffer.from(chunk));
          }
          const upstream = await fetch(url, {
            method: request.method ?? "GET",
            headers: request.headers.authorization
              ? { authorization: request.headers.authorization }
              : {},
            ...(size ? { body: Buffer.concat(chunks) } : {}),
            signal: AbortSignal.timeout(3000),
          });
          const body = Buffer.from(await upstream.arrayBuffer());
          assert.ok(body.length <= 1048576);
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(body);
        })().catch((error: unknown) => {
          failures.push(error);
          response.destroy();
        });
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", (error: NodeJS.ErrnoException) => {
          if (!["EPIPE", "ECONNRESET"].includes(error.code ?? "")) failures.push(error);
        });
      });
      server.on("upgrade", (request, rawSocket, head) => {
        const socket = rawSocket as Socket;
        try {
          assert.equal(head.length, 0);
          assert.match(request.url ?? "", /^\/v1\/stream\?ticket=synthetic-ticket-/);
          const accept = createHash("sha1")
            .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          upgrades++;
          // Commit a three-page interval strictly after the initial HTTP catchup.
          if (upgrades === 2) last = 6;
          let pending = Buffer.alloc(0);
          socket.on("data", (chunk: Buffer) => {
            try {
              pending = Buffer.concat([pending, chunk]);
              assert.ok(pending.length <= 8192);
              while (pending.length >= 2) {
                assert.ok(pending[1]! & 128);
                let length = pending[1]! & 127,
                  offset = 2;
                if (length === 126) {
                  if (pending.length < 4) return;
                  length = pending.readUInt16BE(2);
                  offset = 4;
                }
                assert.ok(length < 4096);
                if (pending.length < offset + 4 + length) return;
                const opcode = pending[0]! & 15;
                const mask = pending.subarray(offset, offset + 4);
                const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
                for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
                pending = pending.subarray(offset + 4 + length);
                if (opcode === 8) {
                  socket.end(Buffer.from([0x88, 0]));
                  continue;
                }
                assert.equal(opcode, 1);
                const command = JSON.parse(payload.toString());
                assert.equal(command.type, "conversation.subscribe");
                assert.equal(command.input.query.after, 1);
                send(socket, {
                  type: "ack",
                  requestId: command.requestId,
                  operationId: "replayEvents",
                  receipt: page(1, last),
                });
                if (upgrades === 2) {
                  // New history beyond the ACK barrier already exists when HTTP
                  // drain begins. Socket data is queued immediately behind ACK.
                  last = 7;
                  send(socket, event(7));
                  send(socket, event(7));
                }
              }
            } catch (error) {
              failures.push(error);
              socket.destroy();
            }
          });
        } catch (error) {
          failures.push(error);
          socket.destroy();
        }
      });
      let python: ReturnType<typeof spawn> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let exited: Promise<number | null> | undefined;
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        // Python supplies application callbacks; TypeScript owns the fixture,
        // subprocess lifecycle, independent assertions and test runner.
        python = spawn(
          "python3",
          [
            "-I",
            "-B",
            "-c",
            `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('fortipi_example',sys.argv[1])
m=importlib.util.module_from_spec(spec); sys.modules[spec.name]=m; spec.loader.exec_module(m)
c=m.Client(sys.argv[2], '${primary}', allow_loopback_http=True, timeout=3)
applied=[]; attempted=[]; subscription=None
try:
    first=m.Subscription(c,'agent-A','conversation-A',on_snapshot=lambda s:None,on_event=lambda e:None)
    checkpoint=first.checkpoint; first.close()
    def handler(e):
        attempted.append(e['eventSeq'])
        if sys.argv[3]=='true' and e['eventSeq']==4: raise RuntimeError('handler failure')
        applied.append(e['eventSeq'])
    try:
        subscription=m.Subscription(c,'agent-A','conversation-A',on_snapshot=lambda s:None,on_event=handler,checkpoint=checkpoint)
        ready=subscription.cursor
        subscription.next(); subscription.next()
        result={'ready':ready,'cursor':checkpoint.cursor,'applied':applied,'attempted':attempted}
    except RuntimeError:
        result={'failed':True,'cursor':checkpoint.cursor,'applied':applied,'attempted':attempted,'seen':list(checkpoint.seen)}
    print(json.dumps(result))
finally:
    if subscription: subscription.close()
    c.cancel()
`,
            resolve(root, "examples/python-client/client.py"),
            `http://127.0.0.1:${address.port}`,
            String(failHandler),
          ],
          {
            cwd: root,
            env: pythonEnvironment(),
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        exited = new Promise((accept, reject) => {
          python!.once("error", reject);
          python!.once("close", accept);
        });
        timer = setTimeout(() => python!.kill("SIGKILL"), 10000);
        let output = "",
          diagnostics = "";
        python.stdout!.on("data", (b: Buffer) => {
          output += b.toString();
          assert.ok(output.length <= 4096);
        });
        python.stderr!.on("data", (b: Buffer) => {
          diagnostics += b.toString();
          assert.ok(diagnostics.length <= 4096);
        });
        assert.equal(await exited, 0);
        assert.equal(diagnostics, "");
        assert.deepEqual(
          JSON.parse(output),
          failHandler
            ? {
                failed: true,
                cursor: 3,
                applied: [2, 3],
                attempted: [2, 3, 4],
                seen: [2, 3],
              }
            : {
                ready: 6,
                cursor: 7,
                applied: [2, 3, 4, 5, 6, 7],
                attempted: [2, 3, 4, 5, 6, 7],
              },
        );
        assert.deepEqual(pages, [
          { after: 1, through: null, nextAfter: 1 },
          { after: 1, through: null, nextAfter: 1 },
          { after: 3, through: 6, nextAfter: 5 },
          ...(!failHandler ? [{ after: 5, through: 6, nextAfter: 6 }] : []),
        ]);
        assert.deepEqual(failures, []);
        assert.deepEqual(peer.failures, []);
      } finally {
        if (timer) clearTimeout(timer);
        if (python && python.exitCode === null && python.signalCode === null)
          python.kill("SIGKILL");
        if (exited) await exited;
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise<void>((accept) => server.close(() => accept()));
        await peer.close();
      }
    });
  }
});

function pythonEnvironment(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" };
  if (process.platform === "win32") {
    assert.ok(process.env.SystemRoot, "Python requires the Windows system context");
    env.SystemRoot = process.env.SystemRoot;
  }
  if (token !== undefined) env.FORTIPI_CLIENT_TOKEN = token;
  return env;
}
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
      env: pythonEnvironment(token),
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
    { env: pythonEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
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
