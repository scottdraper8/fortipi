import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
  WorkspaceRef,
} from "@cloudflare/computer/backends/container";
import { requireThat } from "../workspace/errors.js";

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
  queryOnly = false;
  runtime: ContainerRuntimeInfo | undefined;
  constructor(host: IWorkspaceContainerAPI) {
    this.host = host;
  }
  async start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    requireThat(!this.queryOnly, "interrupted", "Query cannot start a container");
    const runtime = await this.host.start(spec);
    requireThat(
      !this.runtime || this.runtime.runtimeId === runtime.runtimeId,
      "interrupted",
      "Container runtime replaced",
    );
    this.runtime = runtime;
    await this.host.setInactivityTimeout(60_000);
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
      // Resolve the native capability before fetch: pipelining .fetch on the RPC promise
      // still serializes Request.signal through custom RPC in the pinned runtime.
      stage = "port-capability";
      const portFetcher = await this.host.port(port);
      stage = "native-fetch";
      const response = await portFetcher.fetch(new Request(input, init));
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
