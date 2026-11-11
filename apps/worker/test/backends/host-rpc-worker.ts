import { DurableObject, RpcTarget } from "cloudflare:workers";
import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
  WorkspaceRef,
} from "@cloudflare/computer/backends/container";
import {
  containerRequestFailureStage,
  FencedContainerAPI,
} from "../../src/container/host-adapter.js";
import {
  ContainerHostTransport,
  containerRuntimeHeader,
} from "../../src/container/host-transport.js";
import { requireThat } from "../../src/workspace/errors.js";

interface ProbeEnv {
  HOST: DurableObjectNamespace<HostProbe>;
  PORT: Fetcher;
}
/** Transport/lifecycle fixture, never a Linux or container-execution substitute. */
class PortAPI extends RpcTarget implements IWorkspaceContainerAPI {
  readonly portFetcher: Fetcher;
  readonly storage: DurableObjectStorage;
  fault: string | undefined;
  statusCalls = 0;
  constructor(portFetcher: Fetcher, storage: DurableObjectStorage, fault?: string) {
    super();
    this.portFetcher = portFetcher;
    this.storage = storage;
    this.fault = fault;
  }
  async start(_spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    const starts = ((await this.storage.get<number>("starts")) ?? 0) + 1;
    await this.storage.put("starts", starts);
    return {
      runtimeId: `transport-runtime-${starts}`,
      clientSecret: "synthetic-test-only",
      outcome: "launched",
    };
  }
  async restart(_spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    throw new Error("Unexpected restart");
  }
  async interceptOutboundHttp(_host: string, _workspace: WorkspaceRef) {}
  async interceptAllOutboundHttp(_workspace: WorkspaceRef, _token: string) {}
  async setInactivityTimeout(_ms: number) {
    await this.storage.put("timeouts", ((await this.storage.get<number>("timeouts")) ?? 0) + 1);
  }
  async status() {
    this.statusCalls++;
    if (this.fault === "before-status" || (this.fault === "after-status" && this.statusCalls === 4))
      throw new Error("Intentional status fault");
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
    if (this.fault === "port-capability") throw new Error("Intentional capability fault");
    return this.portFetcher;
  }
  fetchPort(_port: number, input: RequestInfo | URL, init?: RequestInit) {
    return this.portFetcher.fetch(input, init);
  }
}
export class HostProbe extends DurableObject<ProbeEnv> {
  #native: PortAPI | undefined;
  #transport: ContainerHostTransport | undefined;
  #image = "fixture-image";
  #selected = true;
  #host(): ContainerHostTransport {
    this.#native ??= new PortAPI(this.env.PORT, this.ctx.storage);
    this.#transport ??= new ContainerHostTransport(this.ctx.storage, this.#native, () => {
      requireThat(this.#selected, "unsupported", "Fixture Linux selection disabled");
      return this.#image;
    });
    return this.#transport;
  }
  async getWorkspaceContainer() {
    return this.#host().getWorkspaceContainer();
  }
  async setFault(fault: string) {
    this.#host();
    if (this.#native) {
      this.#native.fault = fault;
      this.#native.statusCalls = 0;
    }
  }
  override fetch(request: Request) {
    return this.#host().fetch(request);
  }
  setConfiguration(selected: boolean, image: string) {
    this.#selected = selected;
    this.#image = image;
  }
  async timeouts() {
    return (await this.ctx.storage.get<number>("timeouts")) ?? 0;
  }
  async rawFetchPort(port: number, input: RequestInfo | URL, init?: RequestInit) {
    return this.#host().native.fetchPort(port, input, init);
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
  async fetch(request: Request, env: ProbeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/state") return Response.json({ started, aborted });
    if (url.pathname === "/echo")
      return Response.json({
        method: request.method,
        header: request.headers.get("x-canary"),
        body: await request.text(),
        privateHeader: request.headers.has(containerRuntimeHeader),
      });
    if (url.pathname === "/upgrade") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (event) => pair[1].send(event.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/stream")
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            ctx.waitUntil(
              pause(500).then(() => {
                controller.enqueue(new TextEncoder().encode("second"));
                controller.close();
              }),
            );
          },
        }),
      );
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
        await hostObject.rawFetchPort(8080, "https://port/echo", {
          signal: AbortSignal.timeout(1000),
        });
        return Response.json({ rejected: false });
      } catch (error) {
        return Response.json({
          rejected: true,
          serialization: error instanceof Error && /AbortSignal serialization/.test(error.message),
        });
      }
    }
    const adapter = new FencedContainerAPI(host, hostObject);
    if (url.pathname === "/query-unknown") {
      adapter.runtime = {
        runtimeId: "unknown-runtime",
        clientSecret: "synthetic-test-only",
        outcome: "adopted",
      };
      adapter.queryOnly = true;
      let rejected = false;
      try {
        await adapter.fetchPort(8080, "https://port/echo");
      } catch {
        rejected = true;
      }
      return Response.json({ rejected, starts: await hostObject.starts() });
    }
    await adapter.start({ env: {}, enableInternet: false });
    if (
      ["/missing-runtime", "/stale-runtime", "/changed-image", "/unselected"].includes(url.pathname)
    ) {
      if (url.pathname === "/stale-runtime") {
        const replacement = await hostObject.getWorkspaceContainer();
        await replacement.start({ env: {}, enableInternet: false });
      }
      if (url.pathname === "/changed-image")
        await hostObject.setConfiguration(true, "changed-image");
      if (url.pathname === "/unselected") await hostObject.setConfiguration(false, "fixture-image");
      let rejected = false;
      try {
        if (url.pathname === "/missing-runtime")
          await hostObject.fetch(new Request("https://port/echo"));
        else await adapter.fetchPort(8080, "https://port/echo");
      } catch {
        rejected = true;
      }
      let staleMutationRejected = true;
      if (url.pathname === "/stale-runtime") {
        try {
          await host.setInactivityTimeout(1);
          staleMutationRejected = false;
        } catch {}
      }
      return Response.json({
        rejected,
        staleMutationRejected,
        starts: await hostObject.starts(),
        timeouts: await hostObject.timeouts(),
      });
    }
    if (url.pathname === "/queue-replacement") {
      const controller = new AbortController();
      const before = await (await env.PORT.fetch("https://port/state")).json<{ started: number }>();
      const pending = adapter
        .fetchPort(8080, "https://port/slow", { signal: controller.signal })
        .then(
          () => false,
          () => true,
        );
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await (await env.PORT.fetch("https://port/state")).json<{
          started: number;
        }>();
        if (state.started > before.started) break;
        await pause(5);
      }
      const replacement = await hostObject.getWorkspaceContainer();
      const starting = replacement.start({ env: {}, enableInternet: false });
      await pause(20);
      const startsDuringRequest = await hostObject.starts();
      controller.abort(new Error("Synthetic queued cancellation"));
      const rejected = await pending;
      await starting;
      return Response.json({ rejected, startsDuringRequest, starts: await hostObject.starts() });
    }
    if (url.pathname === "/run-upgrade")
      return adapter.fetchPort(8080, "https://port/upgrade", { headers: { Upgrade: "websocket" } });
    if (url.pathname === "/run-stream" || url.pathname === "/baseline-stream") {
      const response =
        url.pathname === "/run-stream"
          ? await adapter.fetchPort(8080, "https://port/stream")
          : await env.PORT.fetch("https://port/stream");
      requireThat(response.body, "internal", "Fixture stream body missing");
      const reader = response.body.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      const second = new TextDecoder().decode((await reader.read()).value);
      return Response.json({ first, second, done: (await reader.read()).done });
    }
    if (url.pathname.startsWith("/stage-")) {
      await hostObject.setFault(url.pathname.slice(7));
      try {
        await adapter.fetchPort(8080, "https://port/echo");
        return Response.json({ rejected: false });
      } catch (error) {
        return Response.json({
          stage: containerRequestFailureStage(error),
          causedStage: containerRequestFailureStage(
            new Error("Synthetic outer wrapper", { cause: error }),
          ),
        });
      }
    }
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
    if (["/cancel", "/timeout", "/baseline-cancel", "/baseline-timeout"].includes(url.pathname)) {
      const controller = new AbortController();
      const signal = url.pathname.endsWith("timeout")
        ? AbortSignal.timeout(100)
        : controller.signal;
      const reason = new Error("Synthetic caller cancellation");
      let failure: unknown;
      const before = await (await env.PORT.fetch("https://port/state")).json<{
        started: number;
        aborted: number;
      }>();
      const direct = url.pathname.startsWith("/baseline-") ? env.PORT : undefined;
      const fetching = direct
        ? direct.fetch(new Request("https://port/slow", { signal }))
        : adapter.fetchPort(8080, "https://port/slow", { signal });
      const pending = fetching.then(
        (response) => {
          void response.body?.cancel();
          return false;
        },
        (error: unknown) => {
          failure = error;
          return true;
        },
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await (await env.PORT.fetch("https://port/state")).json<{
          started: number;
          aborted: number;
        }>();
        if (state.started > before.started) break;
        await pause(5);
      }
      if (url.pathname.endsWith("cancel")) controller.abort(reason);
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
      return Response.json({
        rejected,
        observed,
        stage: containerRequestFailureStage(failure),
        reasonPreserved: failure === signal.reason,
      });
    }
    return new Response(null, { status: 404 });
  },
};
