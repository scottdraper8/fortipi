import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";

interface Env {
  LOADER: WorkerLoader;
  PROBES: DurableObjectNamespace<UpgradeProbe>;
}

/** Controlled close latency around a real Loader backend; no substitute execution port. */
export class UpgradeProbe extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    let release = () => {},
      entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let draining = false,
      released = false,
      overlapped = false;
    const backend = new CodemodeBackend({
      loader: this.env.LOADER,
      id: "probe",
      root: "/workspace",
      access: "read-write",
      modules: {},
      onInterrupt: "fail",
      egress: { mode: "none" },
      keepAliveIntervalMs: 0,
      maxTimeoutMs: 5000,
    });
    const connect = backend.connect.bind(backend);
    backend.connect = async (host) => {
      if (draining && !released) overlapped = true;
      const native = await connect(host);
      return new Proxy(native, {
        get(target, name) {
          if (name === "close")
            return async () => {
              draining = true;
              entered();
              await gate;
              await target.close?.();
            };
          const value = Reflect.get(target, name);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const ws = new Workspace({ storage: this.ctx.storage, backends: [backend] });
    const source = (text: string) =>
      `import {writeFile} from 'node:fs/promises'; export default async function(){await writeFile('/workspace/result',${JSON.stringify(text)});}`;
    try {
      await ws.fs.mkdir("/workspace", { recursive: true });
      const first = await ws.runtime.exec(source("first"), {
        id: "first",
        backend: "probe",
        encoding: "utf8",
        onInterrupt: "fail",
        sync: "wait",
      });
      const firstResult = await first.result();
      const close = ws.close();
      await closing;
      const next = ws.runtime.exec(source("second"), {
        id: "second",
        backend: "probe",
        encoding: "utf8",
        onInterrupt: "fail",
        sync: "wait",
      });
      // Let actual backend connection work reach the controlled close barrier.
      await new Promise((resolve) => setTimeout(resolve, 100));
      released = true;
      release();
      await close;
      const secondResult = await (await next).result();
      return Response.json({
        first: firstResult.status,
        firstSync: firstResult.sync.status,
        firstSkipped: firstResult.skipped.length,
        second: secondResult.status,
        secondSync: secondResult.sync.status,
        secondSkipped: secondResult.skipped.length,
        content: await ws.fs.readFile("/workspace/result", "utf8"),
        overlapped,
        physicalBytes: this.ctx.storage.sql.databaseSize,
        tables: this.ctx.storage.sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .toArray()
          .map((row) => row.name),
      });
    } finally {
      released = true;
      release();
      await ws.close();
    }
  }
}

export default {
  fetch(request: Request, env: Env) {
    return env.PROBES.getByName("upgrade").fetch(request);
  },
};
