import { RpcTarget } from "cloudflare:workers";
import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
  WorkspaceRef,
} from "@cloudflare/computer/backends/container";
import { requireThat } from "../workspace/errors.js";

export const containerRuntimeHeader = "x-fortipi-container-runtime";
interface Allocation {
  runtimeId: string;
  image: string;
}
const allocationKey = "fortipi-container-allocation";

/** Lives inside the owning DO. Native TCP Fetchers never cross custom RPC. */
export class ContainerHostTransport {
  private tail: Promise<void> = Promise.resolve();
  readonly storage: DurableObjectStorage;
  readonly native: IWorkspaceContainerAPI;
  readonly configuredImage: () => string;
  constructor(
    storage: DurableObjectStorage,
    native: IWorkspaceContainerAPI,
    configuredImage: () => string,
  ) {
    this.storage = storage;
    this.native = native;
    this.configuredImage = configuredImage;
  }
  getWorkspaceContainer(): IWorkspaceContainerAPI {
    this.configuredImage();
    return new RegisteredContainerAPI(this);
  }
  private async serialize<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  private async check(runtimeId: string | null): Promise<void> {
    const image = this.configuredImage();
    const status = await this.native.status();
    const current = await this.storage.get<Allocation>(allocationKey);
    requireThat(
      runtimeId &&
        current?.runtimeId === runtimeId &&
        current.image === image &&
        this.configuredImage() === image &&
        status.running &&
        status.exit === null,
      "interrupted",
      "Recorded container allocation is unavailable",
    );
  }
  start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    return this.serialize(async () => {
      const image = this.configuredImage();
      // Invalidate the old owned allocation before any SDK start/replacement effect.
      await this.storage.delete(allocationKey);
      const runtime = await this.native.start(spec);
      const status = await this.native.status();
      requireThat(
        runtime.runtimeId &&
          this.configuredImage() === image &&
          status.running &&
          status.exit === null,
        "interrupted",
        "Container launch was not observed running",
      );
      await this.storage.put(allocationKey, {
        runtimeId: runtime.runtimeId,
        image,
      } satisfies Allocation);
      return runtime;
    });
  }
  owned<T>(runtimeId: string | undefined, work: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      await this.check(runtimeId ?? null);
      const result = await work();
      await this.check(runtimeId ?? null);
      return result;
    });
  }
  fetch(request: Request): Promise<Response> {
    return this.serialize(async () => {
      request.signal.throwIfAborted();
      await this.check(request.headers.get(containerRuntimeHeader));
      request.signal.throwIfAborted();
      const headers = new Headers(request.headers);
      headers.delete(containerRuntimeHeader);
      // Same-DO synchronous port acquisition and native HTTP remain inside the start FIFO
      // through response headers, so an awaited connection cannot target a later start.
      const response = await this.native.port(8080).fetch(new Request(request, { headers }));
      try {
        await this.check(request.headers.get(containerRuntimeHeader));
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        try {
          response.webSocket?.close(1008, "Container allocation changed");
        } catch {}
        throw error;
      }
      // Preserve the native body, stream and WebSocket101 response without cloning/buffering.
      return response;
    });
  }
}

class RegisteredContainerAPI extends RpcTarget implements IWorkspaceContainerAPI {
  #attempted = false;
  #runtimeId: string | undefined;
  readonly #owner: ContainerHostTransport;
  constructor(owner: ContainerHostTransport) {
    super();
    this.#owner = owner;
  }
  async start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    requireThat(!this.#attempted, "interrupted", "Container start was already attempted");
    this.#attempted = true;
    const runtime = await this.#owner.start(spec);
    this.#runtimeId = runtime.runtimeId;
    return runtime;
  }
  async restart(_spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    requireThat(false, "interrupted", "Automatic container restart is disabled");
  }
  interceptOutboundHttp(host: string, workspace: WorkspaceRef) {
    return this.#owner.owned(this.#runtimeId, () =>
      this.#owner.native.interceptOutboundHttp(host, workspace),
    );
  }
  interceptAllOutboundHttp(workspace: WorkspaceRef, token: string) {
    return this.#owner.owned(this.#runtimeId, () =>
      this.#owner.native.interceptAllOutboundHttp(workspace, token),
    );
  }
  setInactivityTimeout(ms: number) {
    return this.#owner.owned(this.#runtimeId, () => this.#owner.native.setInactivityTimeout(ms));
  }
  async status() {
    this.#owner.configuredImage();
    return this.#owner.native.status();
  }
  async exitInfo() {
    this.#owner.configuredImage();
    return this.#owner.native.exitInfo();
  }
  port(_port: number): Fetcher {
    requireThat(false, "unsupported", "Native container ports cannot be exported through RPC");
  }
  async fetchPort(
    _port: number,
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> {
    requireThat(false, "unsupported", "Use the existing host HTTP fetch transport");
  }
}
