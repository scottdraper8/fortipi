import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface PublicRole {
  endpoint: string;
  token: string;
  agentId: string;
  conversationId: string;
}
export function pythonClient(role: PublicRole) {
  const endpoint = new URL(role.endpoint);
  const local =
    endpoint.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  assert.ok(local || endpoint.protocol === "https:");
  const child = spawn(
    "python3",
    [
      "-I",
      "-B",
      resolve(import.meta.dirname, "../../examples/python-client/client.py"),
      "--endpoint",
      role.endpoint,
      ...(local ? ["--allow-loopback-http"] : []),
      "--timeout",
      "30",
    ],
    {
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        FORTIPI_CLIENT_TOKEN: role.token,
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines: Record<string, unknown>[] = [];
  const waiting: { accept(value: Record<string, unknown>): void; reject(error: Error): void }[] =
    [];
  let buffer = "",
    bytes = 0,
    diagnostics = false;
  const fail = () => {
    for (const waiter of waiting.splice(0))
      waiter.reject(new Error("Independent Python failed or omitted required response"));
    child.kill("SIGKILL");
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    bytes += Buffer.byteLength(data);
    if (bytes > 65536) {
      fail();
      return;
    }
    buffer += data;
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n"),
        line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const value: unknown = JSON.parse(line);
        assert.ok(value && typeof value === "object" && !Array.isArray(value));
        const result = value as Record<string, unknown>;
        assert.ok(!JSON.stringify(result).includes(role.token));
        const waiter = waiting.shift();
        if (waiter) waiter.accept(result);
        else lines.push(result);
      } catch {
        fail();
      }
    }
  });
  child.stderr.on("data", () => {
    diagnostics = true;
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  const exited = new Promise<number | null>((accept) =>
    child.once("close", (code) => {
      for (const waiter of waiting.splice(0))
        waiter.reject(new Error("Python closed before its public response"));
      accept(code);
    }),
  );
  return {
    async command(input: object) {
      const response = lines.length
        ? Promise.resolve(lines.shift()!)
        : new Promise<Record<string, unknown>>((accept, reject) =>
            waiting.push({ accept, reject }),
          );
      const timer = setTimeout(fail, 35000);
      child.stdin.write(`${JSON.stringify(input)}\n`);
      try {
        const value = await response;
        assert.equal(value.ok, true, "Independent Python public operation failed");
        return value;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        assert.equal(await exited, 0);
        assert.equal(diagnostics, false);
        assert.equal(buffer, "");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
export async function python(role: PublicRole) {
  const a = pythonClient(role),
    b = pythonClient(role);
  try {
    const discovery = await a.command({ op: "discover" });
    assert.equal(discovery.protocolVersion, "1.0");
    assert.equal(discovery.schemas, 15);
    await a.command({ op: "agents" });
    await a.command({ op: "conversations", agentId: role.agentId });
    const before = await a.command({ op: "snapshot", conversationId: role.conversationId });
    await a.command({
      op: "subscribe",
      agentId: role.agentId,
      conversationId: role.conversationId,
    });
    const intent = {
      op: "send",
      conversationId: role.conversationId,
      clientRequestId: crypto.randomUUID(),
      content: "seed1010-python",
    };
    const receipt = await a.command(intent);
    assert.deepEqual(await a.command(intent), receipt);
    await a.command({ op: "completion", taskId: receipt.taskId });
    const disconnected = await a.command({ op: "disconnect" });
    await b.command({ op: "discover" });
    await b.command({
      op: "subscribe",
      agentId: role.agentId,
      conversationId: role.conversationId,
    });
    const other = await b.command({
      ...intent,
      clientRequestId: crypto.randomUUID(),
      content: "seed1010-python-offline",
    });
    await b.command({ op: "completion", taskId: other.taskId });
    const replay = await a.command({ op: "replay" });
    assert.equal(replay.applied, false);
    assert.equal(replay.cursor, disconnected.cursor);
    const resumed = await a.command({
      op: "subscribe",
      agentId: role.agentId,
      conversationId: role.conversationId,
      resume: true,
    });
    assert.ok(Number(resumed.cursor) > Number(disconnected.cursor));
    const after = await a.command({ op: "snapshot", conversationId: role.conversationId });
    assert.ok(Number(after.messages) > Number(before.messages));
    return {
      independentStdlibPython: true,
      discovery: true,
      actualTaskIds: [receipt.taskId, other.taskId],
      explicitRetrySameReceipt: true,
      committedMessagesIncreased: true,
      resumedOfflineEvents: replay.events,
      cursorAdvanced: true,
      noSdkOrTransportInjection: true,
    };
  } finally {
    await Promise.allSettled([a.close(), b.close()]).then((closed) => {
      assert.ok(
        closed.every((r) => r.status === "fulfilled"),
        "Independent Python cleanup failed",
      );
    });
  }
}
