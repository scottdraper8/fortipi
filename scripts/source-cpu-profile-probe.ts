/** Temporary, post-deadline source diagnostic; never a runtime or release receipt. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const attempted = new Set<number>();
const maximumMessage = 8_000_000;
const maximumSamples = 20_000;
type Frame = {
  diagnostic: "source-cpu-profile-frame";
  source: "inspector-script";
  sha256: string;
  /** One-based line in the exact script bytes identified by sha256. */
  line: number;
  samples: number;
};
type Summary = {
  diagnostic: "source-cpu-profile";
  available: boolean;
  samples: number;
  /** Includes unknown scripts/lines and rows excluded by the eight-row bound. */
  unmapped: number;
};
function integer(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function discover(port: number, signal: AbortSignal): Promise<URL> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    redirect: "error",
    signal,
  });
  assert.ok(response.ok && response.body);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      assert.ok(size <= 65_536);
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const targets: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  // The fixture has one application Worker. Never pick an arbitrary target.
  assert.ok(Array.isArray(targets) && targets.length === 1);
  const target = record(targets[0]);
  assert.equal(target.type, "node");
  assert.ok(typeof target.webSocketDebuggerUrl === "string");
  const url = new URL(target.webSocketDebuggerUrl);
  assert.ok(
    url.protocol === "ws:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.port === String(port) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.length <= 256,
  );
  // Use the already-contacted IPv4 loopback, never DNS or a returned authority.
  url.hostname = "127.0.0.1";
  return url;
}

function wait<T>(
  socket: WebSocket,
  signal: AbortSignal,
  event: "open" | "message",
  accept: (value: Event) => T | undefined,
  send?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener(event, receive);
      socket.removeEventListener("error", fail);
      socket.removeEventListener("close", fail);
      signal.removeEventListener("abort", fail);
    };
    const fail = () => {
      cleanup();
      reject(new Error("CPU diagnostic unavailable"));
    };
    const receive = (value: Event) => {
      try {
        const result = accept(value);
        if (result === undefined) return;
        cleanup();
        resolve(result);
      } catch {
        fail();
      }
    };
    socket.addEventListener(event, receive);
    socket.addEventListener("error", fail);
    socket.addEventListener("close", fail);
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) return fail();
    try {
      send?.();
    } catch {
      fail();
    }
  });
}

/** Literal diagnostic opt-in, an already-failed request, and one attempt per port.
 * Profiler.start/stop samples for 500 ms; a separate 2500 ms total bound includes
 * discovery, WebSocket/CDP, script hashing and cleanup initiation. No retries,
 * pause/evaluation commands, raw profile persistence, paths or function output.
 */
export async function observeSourceCpuProfile(
  port: number,
  failedRequest: AbortSignal,
): Promise<void> {
  if (
    process.env.FORTIPI_SOURCE_PI_OPEN_DIAGNOSTICS !== "1" ||
    !failedRequest.aborted ||
    !integer(port, 65_535) ||
    port === 0 ||
    attempted.has(port) ||
    attempted.size >= 128
  )
    return;
  attempted.add(port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  const signal = controller.signal;
  let socket: WebSocket | undefined;
  let profiling = false;
  let summary: Summary = {
    diagnostic: "source-cpu-profile",
    available: false,
    samples: 0,
    unmapped: 0,
  };
  const frames: Frame[] = [];
  try {
    const url = await discover(port, signal);
    // Node's built-in WebSocket supports this options dictionary. Wrangler's
    // inspector requires a local Origin for clients carrying a User-Agent.
    // DOM's constructor declaration omits Node 26's supported headers option.
    const InspectorWebSocket = WebSocket as unknown as new (
      url: URL,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    socket = new InspectorWebSocket(url, { headers: { Origin: "http://localhost" } });
    await wait(socket, signal, "open", () => true);
    const connected = socket;
    let id = 0,
      received = 0;
    const command = (method: string, params: Record<string, unknown> = {}) => {
      const wanted = ++id;
      return wait(
        connected,
        signal,
        "message",
        (event) => {
          const data: unknown = (event as MessageEvent).data;
          assert.ok(typeof data === "string" && data.length <= maximumMessage);
          const bytes = Buffer.byteLength(data);
          assert.ok(bytes <= maximumMessage);
          received += bytes;
          assert.ok(received <= 20_000_000);
          const message = record(JSON.parse(data));
          if (message.id !== wanted) return;
          assert.ok(!message.error);
          // workerd emits only {id} for successful void CDP commands.
          return message.result === undefined ? {} : record(message.result);
        },
        () => connected.send(JSON.stringify({ id: wanted, method, params })),
      );
    };
    // getScriptSource requires Debugger.enable; this does not pause execution.
    await command("Debugger.enable");
    await command("Profiler.enable");
    await command("Profiler.start");
    profiling = true;
    await delay(500, undefined, { signal });
    signal.throwIfAborted();
    const profile = record((await command("Profiler.stop")).profile);
    profiling = false;
    assert.ok(Array.isArray(profile.nodes) && profile.nodes.length <= maximumSamples);
    assert.ok(Array.isArray(profile.samples) && profile.samples.length <= maximumSamples);
    const nodes = new Map<number, Record<string, unknown>>();
    for (const value of profile.nodes) {
      const node = record(value);
      assert.ok(integer(node.id, 1_000_000_000) && !nodes.has(node.id));
      nodes.set(node.id, record(node.callFrame));
    }
    const counts = new Map<number, number>();
    for (const id of profile.samples) {
      assert.ok(integer(id, 1_000_000_000) && nodes.has(id));
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const scripts = new Map<string, string>();
    const rows = new Map<string, Frame>();
    for (const [id, samples] of [...counts].sort((a, b) => b[1] - a[1])) {
      const frame = nodes.get(id);
      assert.ok(frame);
      if (
        typeof frame.scriptId !== "string" ||
        !/^[1-9][0-9]{0,9}$/.test(frame.scriptId) ||
        !integer(frame.lineNumber, 999_998)
      )
        continue;
      if (!scripts.has(frame.scriptId)) {
        if (scripts.size >= 2) continue;
        const script = (await command("Debugger.getScriptSource", { scriptId: frame.scriptId }))
          .scriptSource;
        assert.ok(typeof script === "string" && Buffer.byteLength(script) <= maximumMessage);
        scripts.set(frame.scriptId, createHash("sha256").update(script).digest("hex"));
      }
      const sha256 = scripts.get(frame.scriptId);
      assert.ok(sha256);
      const line = frame.lineNumber + 1;
      const key = `${sha256}:${line}`;
      const row = rows.get(key);
      if (row) row.samples += samples;
      else
        rows.set(key, {
          diagnostic: "source-cpu-profile-frame",
          source: "inspector-script",
          sha256,
          line,
          samples,
        });
    }
    frames.push(...[...rows.values()].sort((a, b) => b.samples - a.samples).slice(0, 8));
    summary = {
      diagnostic: "source-cpu-profile",
      available: true,
      samples: profile.samples.length,
      unmapped: profile.samples.length - frames.reduce((sum, frame) => sum + frame.samples, 0),
    };
    signal.throwIfAborted();
  } catch {
    frames.length = 0;
    summary = { diagnostic: "source-cpu-profile", available: false, samples: 0, unmapped: 0 };
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Keep a silent error listener through the close handshake, including a
    // timed-out CONNECTING socket. Never export inspector error/reason strings.
    socket?.addEventListener("error", () => {}, { once: true });
    try {
      if (profiling && socket?.readyState === WebSocket.OPEN)
        socket.send('{"id":999,"method":"Profiler.stop"}');
      socket?.close();
    } catch {
      // No transport failure may escape into the failed request's catch.
    }
  }
  try {
    console.log(JSON.stringify(summary));
    for (const frame of frames) console.log(JSON.stringify(frame));
  } catch {
    // Diagnostics must not replace the caller's original failed request.
  }
}
