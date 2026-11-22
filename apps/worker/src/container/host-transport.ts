import { RpcTarget } from "cloudflare:workers";
import { createHash } from "node:crypto";
import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
  WorkspaceRef,
} from "@cloudflare/computer/backends/container";
import { canonicalJson, errorStatuses } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import {
  runtimeHostOwnershipLabel as ownershipLabel,
  type RuntimeHostContext,
  type RuntimeHostStorageSample,
  type RuntimeHostStorageSampleInput,
  runtimeHostContextEnv,
} from "../boundary/infrastructure.js";
import { outcome, requireThat, WorkspaceError } from "../workspace/errors.js";
import { limitedStream } from "../workspace/streams.js";
import { hostContext, hostOwnershipDigest } from "./host-context.js";

export const containerRuntimeHeader = "x-fortipi-container-runtime";
interface Allocation {
  runtimeId: string;
  image: string;
  ownershipDigest?: string;
  context?: RuntimeHostContext;
  launchDigest?: string;
}
const allocationKey = "fortipi-container-allocation";
const pendingKey = "fortipi-container-launch-pending";
const stopKey = "fortipi-container-stop";
interface HostOwnership {
  validate(context: RuntimeHostContext, activation: boolean): void;
  policyVersion(): number;
}
interface Stop {
  request: D.RuntimeQuiesceRequest;
  allocation: Allocation;
  receipt?: D.RuntimeQuiescence;
}
interface NativeLifecycle {
  inspect(): Promise<{ image: string; labels: Record<string, string> } | null>;
  destroy(): Promise<void>;
}

/** Lives inside the owning DO. Native TCP Fetchers never cross custom RPC. */
export class ContainerHostTransport {
  private tail: Promise<void> = Promise.resolve();
  readonly storage: DurableObjectStorage;
  readonly native: IWorkspaceContainerAPI;
  readonly configuredImage: () => string;
  readonly lifecycle: NativeLifecycle;
  readonly ownership: HostOwnership;
  constructor(
    storage: DurableObjectStorage,
    native: IWorkspaceContainerAPI,
    configuredImage: () => string,
    lifecycle: NativeLifecycle,
    ownership: HostOwnership,
  ) {
    this.storage = storage;
    this.native = native;
    this.configuredImage = configuredImage;
    this.lifecycle = lifecycle;
    this.ownership = ownership;
  }
  async getWorkspaceContainer(): Promise<IWorkspaceContainerAPI> {
    this.configuredImage();
    requireThat(
      !(await this.storage.get(stopKey)),
      "interrupted",
      "Disposable runtime is permanently stopping or stopped",
    );
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
    requireThat(
      !(await this.storage.get(stopKey)),
      "interrupted",
      "Disposable runtime writer lane is closed",
    );
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
      requireThat(
        !(await this.storage.get(stopKey)),
        "interrupted",
        "Disposable runtime is permanently stopping or stopped",
      );
      requireThat(
        !(await this.storage.get(pendingKey)),
        "interrupted",
        "Prior launch has no acknowledged allocation; cannot replace it",
      );
      const image = this.configuredImage();
      requireThat(
        spec.name === "computerd" && spec.containerSnapshot === undefined,
        "unsupported",
        "Only the selected prepared computerd image may start; snapshots cannot replace its identity",
      );
      const assertion = spec.env[runtimeHostContextEnv];
      requireThat(
        typeof assertion === "string" && new TextEncoder().encode(assertion).length <= 4096,
        "invalid_request",
        "Bounded private Host context required",
      );
      let decoded: unknown;
      try {
        decoded = JSON.parse(assertion);
      } catch {
        requireThat(false, "invalid_request", "Invalid private Host context");
      }
      const context = hostContext(decoded);
      const ownershipDigest = hostOwnershipDigest(context);
      requireThat(this.ownership, "interrupted", "Host namespace ownership is unavailable");
      this.ownership.validate(context, true);
      requireThat(
        image.endsWith(`@${context.imageDigest}`),
        "conflict",
        "Actual prepared image differs from retained Host context",
      );
      requireThat(
        spec.labels?.[ownershipLabel] === ownershipDigest && Object.keys(spec.labels).length <= 10,
        "invalid_request",
        "Complete Host context ownership label required",
      );
      // Never send the private assertion into the VM or mutate the caller's environment.
      const env = { ...spec.env };
      delete env[runtimeHostContextEnv];
      const delegated = { ...spec, env };
      const launchDigest = createHash("sha256").update(canonicalJson(delegated)).digest("hex");
      const previous = await this.storage.get<Allocation>(allocationKey);
      requireThat(
        !previous?.context || canonicalJson(previous.context) === canonicalJson(context),
        "conflict",
        "Immutable retained Host context changed",
      );
      const before = await this.native.status();
      const actual = await this.lifecycle.inspect();
      requireThat(
        before.running
          ? actual &&
              actual.image === image &&
              actual.labels[ownershipLabel] === ownershipDigest &&
              previous?.context &&
              canonicalJson(previous.context) === canonicalJson(context) &&
              previous.launchDigest === launchDigest
          : actual === null,
        "interrupted",
        "Existing native runtime does not match retained launch/image/ownership; replacement is forbidden",
      );
      await this.storage.put(pendingKey, { image, ownershipDigest, context, launchDigest });
      requireThat(
        this.configuredImage() === image,
        "interrupted",
        "Prepared image changed before native start",
      );
      this.ownership.validate(context, true);
      const runtime = await this.native.start(delegated);
      requireThat(
        !before.running || previous?.runtimeId === runtime.runtimeId,
        "interrupted",
        "Native adoption changed the acknowledged runtime identity",
      );
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
        ownershipDigest,
        context,
        launchDigest,
      } satisfies Allocation);
      await this.storage.delete(pendingKey);
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
    if (new URL(request.url).pathname === "/__fortipi/storage-sample") return this.sample(request);
    if (new URL(request.url).pathname === "/__fortipi/runtime-quiesce")
      return this.quiesce(request);
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
  private async sample(request: Request): Promise<Response> {
    const result = await outcome(async () => {
      requireThat(
        request.method === "POST" && !new URL(request.url).search && request.body,
        "invalid_request",
        "Exact private Host sample POST required",
      );
      request.signal.throwIfAborted();
      let decoded: unknown;
      try {
        decoded = await new Response(
          limitedStream(request.body, 65_536, Date.now() + 10_000, false),
        ).json();
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        requireThat(false, "invalid_request", "Invalid bounded Host sample");
      }
      requireThat(
        decoded && typeof decoded === "object" && !Array.isArray(decoded),
        "invalid_request",
        "Closed Host sample required",
      );
      const row = decoded as Record<string, unknown>;
      requireThat(
        Object.keys(row).sort().join(",") ===
          "context,policyVersion,registryVersion,runtimeId,sampleId" &&
          typeof row.sampleId === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.test(row.sampleId) &&
          typeof row.runtimeId === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.test(row.runtimeId) &&
          typeof row.registryVersion === "number" &&
          Number.isSafeInteger(row.registryVersion) &&
          row.registryVersion > 0 &&
          typeof row.policyVersion === "number" &&
          Number.isSafeInteger(row.policyVersion) &&
          row.policyVersion > 0,
        "invalid_request",
        "Exact Host sample identity required",
      );
      const input: RuntimeHostStorageSampleInput = {
        sampleId: row.sampleId,
        policyVersion: row.policyVersion,
        context: hostContext(row.context),
        runtimeId: row.runtimeId,
        registryVersion: row.registryVersion,
      };
      return this.serialize(async (): Promise<RuntimeHostStorageSample> => {
        request.signal.throwIfAborted();
        const check = async () => {
          requireThat(this.ownership, "interrupted", "Retained Host ownership unavailable");
          this.ownership.validate(input.context, false);
          const current = await this.storage.get<Allocation>(allocationKey);
          requireThat(
            current?.context &&
              canonicalJson(current.context) === canonicalJson(input.context) &&
              current.ownershipDigest === hostOwnershipDigest(input.context) &&
              current.runtimeId === input.runtimeId &&
              current.image.endsWith(`@${input.context.imageDigest}`) &&
              !(await this.storage.get(pendingKey)),
            "unauthorized",
            "Host sample does not match acknowledged physical owner",
          );
          request.signal.throwIfAborted();
          return canonicalJson(current);
        };
        const before = await check();
        const prior = await this.storage.get<{
          input: RuntimeHostStorageSampleInput;
          sample: RuntimeHostStorageSample;
        }>(`fortipi-container-sample:${input.sampleId}`);
        requireThat(
          !prior || canonicalJson(prior.input) === canonicalJson(input),
          "conflict",
          "Host sample identity changed",
        );
        if (prior) return prior.sample;
        requireThat(
          input.policyVersion === this.ownership?.policyVersion(),
          "conflict",
          "Current Host sample policy required",
        );
        const sample: RuntimeHostStorageSample = {
          sampleId: input.sampleId,
          context: input.context,
          runtimeId: input.runtimeId,
          registryVersion: input.registryVersion,
          bytes: this.storage.sql.databaseSize,
          observedAt: Date.now(),
        };
        requireThat(
          (await check()) === before,
          "conflict",
          "Host owner changed across physical observation",
        );
        await this.storage.put(`fortipi-container-sample:${input.sampleId}`, { input, sample });
        return sample;
      });
    });
    return result.ok
      ? Response.json(result.value, { headers: { "Cache-Control": "no-store" } })
      : Response.json(result, {
          status: errorStatuses[result.code],
          headers: { "Cache-Control": "no-store" },
        });
  }
  private async quiesce(request: Request): Promise<Response> {
    const result = await outcome(async () => {
      requireThat(
        request.method === "POST" && !new URL(request.url).search && request.body,
        "invalid_request",
        "Exact private runtime quiesce POST required",
      );
      let input: unknown;
      try {
        input = await new Response(
          limitedStream(request.body, 65_536, Date.now() + 10_000, false),
        ).json();
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        requireThat(false, "invalid_request", "Invalid bounded runtime quiesce metadata");
      }
      requireThat(
        input && typeof input === "object" && !Array.isArray(input),
        "invalid_request",
        "Runtime stop identity required",
      );
      const body = input as Record<string, unknown>;
      requireThat(
        Object.keys(body).sort().join(",") === "imageDigest,requestId,runtimeId" &&
          typeof body.requestId === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.test(body.requestId) &&
          typeof body.runtimeId === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.test(body.runtimeId) &&
          typeof body.imageDigest === "string" &&
          /^sha256:[a-f0-9]{64}$/.test(body.imageDigest),
        "invalid_request",
        "Closed exact runtime stop identity required",
      );
      const intent: D.RuntimeQuiesceRequest = {
        requestId: body.requestId,
        runtimeId: body.runtimeId,
        imageDigest: body.imageDigest,
      };
      return this.serialize(async (): Promise<D.RuntimeQuiescence> => {
        const prior = await this.storage.get<Stop>(stopKey);
        requireThat(
          !prior || JSON.stringify(prior.request) === JSON.stringify(intent),
          "conflict",
          "Immutable runtime stop intent changed",
        );
        if (prior?.receipt) return prior.receipt;
        const current = await this.storage.get<Allocation>(allocationKey);
        requireThat(
          current &&
            current.runtimeId === intent.runtimeId &&
            current.image.endsWith(`@${intent.imageDigest}`) &&
            current.ownershipDigest &&
            (!prior || JSON.stringify(prior.allocation) === JSON.stringify(current)) &&
            !(await this.storage.get(pendingKey)),
          "interrupted",
          "Exact acknowledged runtime/image ownership is unavailable",
        );
        const lifecycle = this.lifecycle;
        requireThat(lifecycle, "unsupported", "Owning native lifecycle is unavailable");
        const before = await lifecycle.inspect();
        const status = await this.native.status();
        requireThat(
          before === null
            ? !status.running
            : status.running &&
                before.image === current.image &&
                before.labels[ownershipLabel] === current.ownershipDigest,
          "interrupted",
          "Actual native image/ownership is unknown or replaced",
        );
        requireThat(
          JSON.stringify(await this.storage.get(allocationKey)) === JSON.stringify(current),
          "interrupted",
          "Runtime ownership changed before stop intent",
        );
        // This permanent tombstone precedes destroy and prevents all later acquisition/reopen.
        const stop: Stop = prior ?? { request: intent, allocation: current };
        await this.storage.put(stopKey, stop);
        if (before !== null) await lifecycle.destroy();
        const after = await lifecycle.inspect();
        const stopped = await this.native.status();
        requireThat(
          after === null && !stopped.running,
          "interrupted",
          "Native destruction has not been observed stopped",
        );
        requireThat(
          JSON.stringify(await this.storage.get(allocationKey)) === JSON.stringify(current),
          "interrupted",
          "Runtime ownership changed during stop",
        );
        const receipt: D.RuntimeQuiescence = { ...intent, stopped: true, observedAt: Date.now() };
        await this.storage.put(stopKey, { ...stop, receipt });
        return receipt;
      });
    });
    return result.ok
      ? Response.json(result.value, { headers: { "Cache-Control": "no-store" } })
      : Response.json(result, {
          status: errorStatuses[result.code],
          headers: { "Cache-Control": "no-store" },
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
