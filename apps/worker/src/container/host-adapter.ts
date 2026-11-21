import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
  WorkspaceRef,
} from "@cloudflare/computer/backends/container";
import {
  type RuntimeHostContext,
  runtimeHostContextEnv,
  runtimeHostOwnershipLabel,
} from "../boundary/infrastructure.js";
import { requireThat } from "../workspace/errors.js";
import { hostContext, hostOwnershipDigest } from "./host-context.js";
import { containerRuntimeHeader } from "./host-transport.js";

type RequestStage = "before-status" | "port-capability" | "native-fetch" | "after-status";
const failedRequestStages = new WeakMap<object, RequestStage>();

/** Fixed diagnostic labels only; preserve original errors and never expose their contents. */
export function containerRequestFailureStage(error: unknown): RequestStage | undefined {
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth++) {
    if ((typeof error !== "object" || error === null) && typeof error !== "function") return;
    if (seen.has(error)) return;
    seen.add(error);
    const stage = failedRequestStages.get(error);
    if (stage) return stage;
    error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
  }
}

/** Typed delegation of the exact 0.10.0 API. Query/cancel cannot launch or replace a runtime. */
export class FencedContainerAPI implements IWorkspaceContainerAPI {
  readonly host: IWorkspaceContainerAPI;
  readonly transport: Fetcher;
  queryOnly = false;
  runtime: ContainerRuntimeInfo | undefined;
  readonly context: RuntimeHostContext;
  readonly started: ((runtime: ContainerRuntimeInfo) => Promise<void>) | undefined;
  constructor(
    host: IWorkspaceContainerAPI,
    transport: Fetcher,
    context: RuntimeHostContext,
    started?: (runtime: ContainerRuntimeInfo) => Promise<void>,
  ) {
    this.host = host;
    this.transport = transport;
    this.context = hostContext(context);
    this.started = started;
  }
  async start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    requireThat(!this.queryOnly, "interrupted", "Query cannot start a container");
    requireThat(
      !Object.hasOwn(spec.env, runtimeHostContextEnv) &&
        !Object.hasOwn(spec.labels ?? {}, runtimeHostOwnershipLabel),
      "invalid_request",
      "Caller cannot supply private Host assertions",
    );
    const context = this.context;
    const serialized = JSON.stringify(context);
    requireThat(
      !serialized || new TextEncoder().encode(serialized).length <= 4096,
      "invalid_request",
      "Private Host assertion exceeds bound",
    );
    const runtime = await this.host.start({
      ...spec,
      env: { ...spec.env, [runtimeHostContextEnv]: serialized },
      labels: { ...spec.labels, [runtimeHostOwnershipLabel]: hostOwnershipDigest(context) },
    });
    requireThat(
      !this.runtime || this.runtime.runtimeId === runtime.runtimeId,
      "interrupted",
      "Container runtime replaced",
    );
    this.runtime = runtime;
    await this.host.setInactivityTimeout(60_000);
    await this.started?.(runtime);
    return runtime;
  }
  async restart(_spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    requireThat(false, "interrupted", "Automatic container restart is disabled");
  }
  interceptOutboundHttp(host: string, workspace: WorkspaceRef) {
    return this.host.interceptOutboundHttp(host, workspace);
  }
  interceptAllOutboundHttp(workspace: WorkspaceRef, token: string) {
    return this.host.interceptAllOutboundHttp(workspace, token);
  }
  async fetchPort(port: number, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let stage: RequestStage = "before-status";
    try {
      const expected = this.runtime?.runtimeId;
      requireThat(expected, "interrupted", "No recorded container runtime");
      const before = await this.host.status();
      requireThat(
        before.running && before.exit === null && this.runtime?.runtimeId === expected,
        "interrupted",
        "Recorded container is no longer available",
      );
      requireThat(port === 8080, "unsupported", "Only the configured computerd port is supported");
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set(containerRuntimeHeader, expected);
      stage = "native-fetch";
      const response = await this.transport.fetch(new Request(request, { headers }));
      stage = "after-status";
      try {
        const after = await this.host.status();
        requireThat(
          after.running && after.exit === null && this.runtime?.runtimeId === expected,
          "interrupted",
          "Container changed during its request",
        );
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      return response;
    } catch (error) {
      if (
        ((typeof error === "object" && error !== null) || typeof error === "function") &&
        !failedRequestStages.has(error)
      )
        failedRequestStages.set(error, stage);
      throw error;
    }
  }
  port(port: number): Fetcher {
    return this.host.port(port);
  }
  setInactivityTimeout(ms: number) {
    return this.host.setInactivityTimeout(ms);
  }
  status() {
    return this.host.status();
  }
  exitInfo() {
    return this.host.exitInfo();
  }
}
