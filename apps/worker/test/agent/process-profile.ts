// Test-only owned fortipi-process proxy. Never decide readiness or retain source/profile data.
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { request } from "node:http";
import { createRequire } from "node:module";

const LIMIT = 2 * 1024 * 1024;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
type Socket = EventEmitter & { readyState: number; send(s: string): void; terminate(): void };
type Method = "Profiler.enable" | "Profiler.start" | "Profiler.stop" | "Profiler.disable";
type Outcome = "not-sent" | "ok" | "cdp-error" | "timeout" | "transport";
type Command = [method: Method, outcome: Outcome, code: number | null];
type Frame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type Profile = {
  nodes: { id: number; callFrame: Frame }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
};
const check: (ok: unknown) => asserts ok = (ok) => {
  if (!ok) throw new Error("unavailable");
};

function discovery(port: number): Promise<unknown> {
  return new Promise((accept, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path: "/json", agent: false, maxHeaderSize: 8192 },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          req.destroy();
          reject();
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (b: Buffer) => {
          size += b.length;
          if (size > 65536) {
            res.destroy();
            req.destroy();
            reject();
          } else chunks.push(b);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            accept(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject();
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject();
    }, 1000);
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
    req.end();
  });
}

function endpoint(targets: unknown, port: number): string {
  check(Array.isArray(targets) && targets.length === 1);
  const t = targets[0];
  const url = `ws://127.0.0.1:${port}/ws`;
  const frontend = `https://devtools.devprod.cloudflare.dev/js_app?theme=systemPreferred&debugger=true&ws=127.0.0.1:${port}/ws`;
  const fields = [
    "id",
    "type",
    "description",
    "webSocketDebuggerUrl",
    "devtoolsFrontendUrl",
    "devtoolsFrontendUrlCompat",
    "title",
    "faviconUrl",
  ];
  check(t && typeof t === "object" && Object.keys(t).sort().join(",") === fields.sort().join(","));
  check(
    typeof t.id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(t.id) &&
      t.type === "node" &&
      t.description === "workers" &&
      t.title === "Cloudflare Worker" &&
      t.webSocketDebuggerUrl === url &&
      t.devtoolsFrontendUrl === frontend &&
      t.devtoolsFrontendUrlCompat === frontend &&
      t.faviconUrl === "https://workers.cloudflare.com/favicon.ico",
  );
  // Only this literal loopback endpoint is used; frontend/favicon are compared,
  // never fetched. The pinned owned proxy routes core:user:fortipi-process.
  return url;
}

function summary(p: Profile) {
  check(p && Array.isArray(p.nodes) && p.nodes.length > 0 && p.nodes.length <= 30000);
  check(
    Array.isArray(p.samples) &&
      p.samples.length <= 100000 &&
      Array.isArray(p.timeDeltas) &&
      p.timeDeltas.length === p.samples.length,
  );
  check(
    Number.isSafeInteger(p.startTime) &&
      Number.isSafeInteger(p.endTime) &&
      p.endTime >= p.startTime &&
      p.endTime - p.startTime <= 5_000_000,
  );
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  check(nodes.size === p.nodes.length);
  for (const n of p.nodes) {
    check(
      Number.isSafeInteger(n.id) &&
        n.id > 0 &&
        n.callFrame &&
        typeof n.callFrame.functionName === "string" &&
        typeof n.callFrame.url === "string" &&
        Number.isSafeInteger(n.callFrame.lineNumber) &&
        n.callFrame.lineNumber >= -1 &&
        n.callFrame.lineNumber <= 9999999 &&
        Number.isSafeInteger(n.callFrame.columnNumber) &&
        n.callFrame.columnNumber >= -1 &&
        n.callFrame.columnNumber <= 9999999,
    );
  }
  const counts = new Map<number, number>();
  for (const id of p.samples) {
    check(nodes.has(id));
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  check(p.timeDeltas.every((v) => Number.isSafeInteger(v) && v >= 0 && v <= 5_000_000));
  return {
    nodes: nodes.size,
    samples: p.samples.length,
    durationUs: p.endTime - p.startTime,
    top: [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, samples]) => {
        const node = nodes.get(id);
        check(node);
        const f = node.callFrame;
        return {
          functionSha256: sha(f.functionName),
          urlSha256: sha(f.url),
          line: f.lineNumber,
          column: f.columnNumber,
          samples,
        };
      }),
  };
}

export async function processProfile(inspectorPort: number) {
  let socket: Socket | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<
    number,
    {
      method: Method;
      accept(v: unknown): void;
      reject(outcome: Outcome, code?: number | null): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const methods: Command[] = [
    "Profiler.enable",
    "Profiler.start",
    "Profiler.stop",
    "Profiler.disable",
  ].map((method) => [method as Method, "not-sent", null]);
  let stage: "discovery" | "connect" | "cdp" | "profile" | "complete" = "discovery";
  let profile: {
    bytes: number;
    sha256: string;
    nodes: number;
    samples: number;
    durationUs: number;
  } | null = null;
  let top: ReturnType<typeof summary>["top"] = [];
  const began = performance.now();
  let failed = false;
  let enabled = false,
    started = false,
    stopAttempted = false;
  let call: ((method: Method) => Promise<unknown>) | undefined;
  const unavailable = (outcome: "transport" | "timeout" = "transport") => {
    failed = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(outcome);
    }
    pending.clear();
  };
  try {
    const port = inspectorPort,
      sampleMs = 350;
    check(Number.isInteger(port) && port > 0 && port <= 65535);
    const url = endpoint(await discovery(port), port);
    stage = "connect";
    const Ws = createRequire(import.meta.resolve("wrangler"))("ws") as new (
      url: string,
      options: Record<string, unknown>,
    ) => Socket;
    socket = new Ws(url, {
      handshakeTimeout: 1000,
      maxPayload: LIMIT,
      perMessageDeflate: false,
      followRedirects: false,
      maxHeaderSize: 8192,
      origin: `http://127.0.0.1:${port}`,
      agent: false,
    });
    const connection = socket;
    watchdog = setTimeout(
      () => {
        unavailable("timeout");
        socket?.terminate();
      },
      Math.max(1, 5000 - (performance.now() - began)),
    );
    socket.on("error", () => unavailable());
    socket.on("close", () => unavailable());
    let received = 0;
    socket.on("message", (data: Buffer, binary: boolean) => {
      received += data.length;
      if (binary || received > LIMIT) {
        unavailable();
        socket?.terminate();
        return;
      }
      try {
        const message = JSON.parse(data.toString("utf8"));
        const p = pending.get(message.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(message.id);
        if (message.error) {
          const code = message.error.code;
          p.reject(
            "cdp-error",
            Number.isSafeInteger(code) && code >= -32768 && code <= 32767 ? code : null,
          );
        } else {
          const command = methods.find((command) => command[0] === p.method);
          check(command);
          command[1] = "ok";
          // CDP void acknowledgments legitimately have no result property.
          p.accept(message.result);
        }
      } catch {
        unavailable();
        socket?.terminate();
      }
    });
    await new Promise<void>((accept, reject) => {
      const done = () => {
        connection.off("error", bad);
        connection.off("close", bad);
        accept();
      };
      const bad = () => {
        connection.off("open", done);
        connection.off("error", bad);
        connection.off("close", bad);
        reject();
      };
      connection.once("open", done);
      connection.once("error", bad);
      connection.once("close", bad);
    });
    let id = 0;
    call = (method: Method) =>
      new Promise<unknown>((accept, reject) => {
        if (failed) {
          reject();
          return;
        }
        if (method === "Profiler.stop") stopAttempted = true;
        const command = methods.find((command) => command[0] === method);
        check(command);
        const current = ++id;
        const bad = (outcome: Outcome, code: number | null = null) => {
          command[1] = outcome;
          command[2] = code;
          reject();
        };
        const timer = setTimeout(() => {
          pending.delete(current);
          bad("timeout");
        }, 1000);
        pending.set(current, { method, accept, reject: bad, timer });
        try {
          connection.send(JSON.stringify({ id: current, method }));
        } catch {
          clearTimeout(timer);
          pending.delete(current);
          bad("transport");
        }
      });
    stage = "cdp";
    enabled = true;
    await call("Profiler.enable");
    started = true;
    await call("Profiler.start");
    await new Promise<void>((accept) => setTimeout(accept, sampleMs));
    const { profile: actual } = (await call("Profiler.stop")) as { profile: Profile };
    started = false;
    stage = "profile";
    const counts = summary(actual);
    const bytes = Buffer.from(JSON.stringify(actual));
    check(bytes.length > 0 && bytes.length <= LIMIT);
    profile = {
      bytes: bytes.length,
      sha256: sha(bytes),
      nodes: counts.nodes,
      samples: counts.samples,
      durationUs: counts.durationUs,
    };
    top = counts.top;
    stage = "complete";
  } catch {
    // Absence of diagnostic data is not an API, runtime or readiness conclusion.
  } finally {
    // The Wrangler proxy may keep its upstream CDP session after disconnect.
    // Best effort within the existing watchdog; never extend the network budget.
    if (started && !stopAttempted && call && !failed) {
      try {
        await call("Profiler.stop");
      } catch {}
    }
    if (enabled && call && !failed) {
      try {
        await call("Profiler.disable");
      } catch {}
    }
    if (watchdog) clearTimeout(watchdog);
    unavailable();
    if (socket && socket.readyState !== 3) {
      const closing = socket;
      await new Promise<void>((accept) => {
        const timer = setTimeout(accept, 250);
        closing.once("close", () => {
          clearTimeout(timer);
          accept();
        });
        closing.terminate();
      });
    }
  }
  return { status: profile ? "available" : "unavailable", stage, methods, profile, top };
}

/** Preserve the existing512-character transport cap; never emit raw CDP data. */
export function processProfileLines(
  result: Awaited<ReturnType<typeof processProfile>>,
  sourcePath: string | null,
  harnessOrdinal: number,
  invocation: number,
): string[] {
  const identity = {
    diagnostic: "source-recovery-profile",
    sourcePath: sourcePath !== null && sourcePath.length <= 64 ? sourcePath : null,
    harnessOrdinal,
    invocation,
  };
  const { top, ...summary } = result;
  return [
    JSON.stringify({ ...identity, ...summary }),
    ...top.map((frame, rank) =>
      JSON.stringify({ ...identity, profileSha256: result.profile?.sha256, rank, ...frame }),
    ),
  ];
}
