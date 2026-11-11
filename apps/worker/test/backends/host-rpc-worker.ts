import { DurableObject, RpcTarget } from "cloudflare:workers";
import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
  WorkspaceRef,
} from "@cloudflare/computer/backends/container";
import { FencedContainerAPI } from "../../src/container/host-adapter.js";

interface ProbeEnv {
  HOST: DurableObjectNamespace<HostProbe>;
  PORT: Fetcher;
}
/** Transport/lifecycle fixture, never a Linux or container-execution substitute. */
class PortAPI extends RpcTarget implements IWorkspaceContainerAPI {
  readonly portFetcher: Fetcher;
  readonly storage: DurableObjectStorage;
  constructor(portFetcher: Fetcher, storage: DurableObjectStorage) {
    super();
    this.portFetcher = portFetcher;
    this.storage = storage;
  }
  async start(_spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    await this.storage.put("starts", ((await this.storage.get<number>("starts")) ?? 0) + 1);
    return {
      runtimeId: "transport-runtime",
      clientSecret: "synthetic-test-only",
      outcome: "launched",
    };
  }
  async restart(_spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    throw new Error("Unexpected restart");
  }
  async interceptOutboundHttp(_host: string, _workspace: WorkspaceRef) {}
  async interceptAllOutboundHttp(_workspace: WorkspaceRef, _token: string) {}
  async setInactivityTimeout(_ms: number) {}
  async status() {
    const exited = await this.storage.get<boolean>("exited");
    return {
      running: !exited,
      exit: exited ? { exitedAt: Date.now(), reason: "fixture exit" } : null,
    };
  }
  async exitInfo() {
    return null;
  }
  port(_port: number): Fetcher {
    return this.portFetcher;
  }
  fetchPort(_port: number, input: RequestInfo | URL, init?: RequestInit) {
    return this.portFetcher.fetch(input, init);
  }
}
export class HostProbe extends DurableObject<ProbeEnv> {
  getWorkspaceContainer() {
    return new PortAPI(this.env.PORT, this.ctx.storage);
  }
  async markExit() {
    await this.ctx.storage.put("exited", true);
  }
  async starts() {
    return (await this.ctx.storage.get<number>("starts")) ?? 0;
  }
  evict() {
    this.ctx.abort("Intentional transport fixture eviction");
  }
}
let started = 0;
let aborted = 0;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/state") return Response.json({ started, aborted });
    if (url.pathname === "/echo")
      return Response.json({
        method: request.method,
        header: request.headers.get("x-canary"),
        body: await request.text(),
      });
    if (url.pathname === "/delayed") {
      started++;
      await pause(50);
      return new Response("delayed");
    }
    if (url.pathname === "/slow") {
      started++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        const cancel = () => {
          clearTimeout(timer);
          aborted++;
          resolve();
        };
        if (request.signal.aborted) cancel();
        else request.signal.addEventListener("abort", cancel, { once: true });
      });
      return new Response("settled");
    }
    const hostObject = env.HOST.getByName(url.pathname);
    const host = await hostObject.getWorkspaceContainer();
    if (url.pathname === "/raw-rpc") {
      try {
        await host.fetchPort(8080, "https://port/echo", { signal: AbortSignal.timeout(1000) });
        return Response.json({ rejected: false });
      } catch (error) {
        return Response.json({
          rejected: true,
          serialization: error instanceof Error && /AbortSignal serialization/.test(error.message),
        });
      }
    }
    const adapter = new FencedContainerAPI(host);
    await adapter.start({ env: {}, enableInternet: false });
    if (url.pathname === "/exit" || url.pathname === "/evict") {
      adapter.queryOnly = true;
      if (url.pathname === "/exit") await hostObject.markExit();
      else await hostObject.evict().catch(() => {});
      let requestRejected = false;
      try {
        await adapter.fetchPort(8080, "https://port/echo");
      } catch {
        requestRejected = true;
      }
      let startRejected = false;
      try {
        await adapter.start({ env: {}, enableInternet: false });
      } catch {
        startRejected = true;
      }
      let restartRejected = false;
      try {
        await adapter.restart({ env: {}, enableInternet: false });
      } catch {
        restartRejected = true;
      }
      return Response.json({
        requestRejected,
        startRejected,
        restartRejected,
        starts: await env.HOST.getByName(url.pathname).starts(),
      });
    }
    if (url.pathname === "/known-change") {
      const before = await (await env.PORT.fetch("https://port/state")).json<{ started: number }>();
      const pending = adapter.fetchPort(8080, "https://port/delayed").then(
        (response) => {
          void response.body?.cancel();
          return false;
        },
        () => true,
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await (await env.PORT.fetch("https://port/state")).json<{
          started: number;
        }>();
        if (state.started > before.started) break;
        await pause(1);
      }
      adapter.runtime = {
        runtimeId: "known-other-runtime",
        clientSecret: "synthetic-test-only",
        outcome: "adopted",
      };
      return Response.json({ rejected: await pending, starts: await hostObject.starts() });
    }
    if (url.pathname === "/run") {
      const response = await adapter.fetchPort(8080, "https://port/echo", {
        method: "POST",
        headers: { "x-canary": "request-header" },
        body: "request-body",
        signal: AbortSignal.timeout(1000),
      });
      return response;
    }
    if (url.pathname === "/cancel" || url.pathname === "/timeout") {
      const controller = new AbortController();
      const signal = url.pathname === "/timeout" ? AbortSignal.timeout(100) : controller.signal;
      const before = await (await env.PORT.fetch("https://port/state")).json<{
        started: number;
        aborted: number;
      }>();
      const pending = adapter.fetchPort(8080, "https://port/slow", { signal }).then(
        (response) => {
          void response.body?.cancel();
          return false;
        },
        () => true,
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await (await env.PORT.fetch("https://port/state")).json<{
          started: number;
          aborted: number;
        }>();
        if (state.started > before.started) break;
        await pause(5);
      }
      if (url.pathname === "/cancel") controller.abort();
      const rejected = await pending;
      let observed = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await (await env.PORT.fetch("https://port/state")).json<{
          started: number;
          aborted: number;
        }>();
        if (state.aborted > before.aborted) {
          observed = true;
          break;
        }
        await pause(5);
      }
      return Response.json({ rejected, observed });
    }
    return new Response(null, { status: 404 });
  },
};
