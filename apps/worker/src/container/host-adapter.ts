import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
  WorkspaceRef,
} from "@cloudflare/computer/backends/container";
import { requireThat } from "../workspace/errors.js";

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
  fetchPort(port: number, input: RequestInfo | URL, init?: RequestInit) {
    return this.host.fetchPort(port, input, init);
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
