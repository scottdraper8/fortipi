import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Workspace, WorkspaceProxy } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { ContainerBackend, WorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import { linuxHostId } from "../../src/backends/linux.js";
import type { RuntimeHostContext } from "../../src/boundary/infrastructure.js";
import {
  containerRequestFailureStage,
  FencedContainerAPI,
} from "../../src/container/host-adapter.js";
import { hostContext } from "../../src/container/host-context.js";
import { ContainerHostTransport } from "../../src/container/host-transport.js";
import { requireThat } from "../../src/workspace/errors.js";

export { WorkspaceProxy };

// Both probe targets use the same host fetch; StepSecurity supplies the policy.
export class ProbeGateway extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const target =
      request.url === "https://registry.npmjs.org/pnpm/12.18.0"
        ? "allowed-registry"
        : request.url === "https://example.com/"
          ? "denied-example"
          : undefined;
    if (request.method !== "HEAD" || !target) return new Response(null, { status: 400 });
    try {
      const response = await fetch(request, {
        redirect: "manual",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(4000)]),
      });
      console.log(
        `fortipi-gateway:${JSON.stringify({ target, forwarded: true, outcome: "response", status: response.status })}`,
      );
      return response;
    } catch (error: unknown) {
      console.log(
        `fortipi-gateway:${JSON.stringify({
          target,
          forwarded: true,
          outcome:
            error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
              ? "aborted"
              : "upstream-error",
          status: null,
        })}`,
      );
      // This status alone never establishes policy denial.
      return new Response(null, { status: 502 });
    }
  }
}

const probeChildId = "fortipi:child:00000000-0000-4000-8000-000000000001";

/** Standalone ABI probe; this context is not a real parent Workspace allocation/pool. */
export class ProbeHost extends DurableObject<ProbeEnv> {
  #transport: ContainerHostTransport | undefined;
  preparedImage(): string {
    const image = this.ctx.container?.images.computerd;
    if (!image || !/@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("Actual immutable prepared computerd image required");
    return image;
  }
  #host(): ContainerHostTransport {
    const container = this.ctx.container;
    requireThat(container, "unsupported", "Actual owning container context required");
    this.#transport ??= new ContainerHostTransport(
      this.ctx.storage,
      new WorkspaceContainerAPI(this.ctx),
      () => this.preparedImage(),
      { inspect: () => container.inspect(), destroy: () => container.destroy() },
      {
        policyVersion: () => 1,
        validate: (context) => {
          requireThat(
            this.env.LINUX_CONTAINERS?.idFromName(context.hostId).equals(this.ctx.id) &&
              context.childId === probeChildId &&
              context.hostId ===
                linuxHostId("probe", this.env.WORKSPACES.idFromName(context.childId).toString()),
            "unauthorized",
            "Actual standalone probe namespace/child mismatch",
          );
        },
      },
    );
    return this.#transport;
  }
  getWorkspaceContainer() {
    return this.#host().getWorkspaceContainer();
  }
  override fetch(request: Request): Promise<Response> {
    return this.#host().fetch(request);
  }
}
interface ProbeEnv {
  WORKSPACES: DurableObjectNamespace<BackendProbe>;
  LINUX_CONTAINERS?: DurableObjectNamespace<ProbeHost>;
  LOADER?: WorkerLoader;
  REQUIRE_FUSE?: string;
}
export class BackendProbe extends DurableObject<ProbeEnv> {
  private workspace: Workspace | undefined;
  private container: ContainerBackend | undefined;
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/run")
      return this.container
        ? this.container.handleFetch(request)
        : new Response(null, { status: 403 });
    const linux = url.searchParams.get("backend") === "linux";
    await this.workspace?.close();
    this.workspace = undefined;
    this.container = undefined;
    let containerHost: FencedContainerAPI | undefined;
    if (linux) {
      if (!this.env.LINUX_CONTAINERS) throw new Error("Container binding required");
      const hostId = linuxHostId("probe", this.ctx.id.toString());
      const host = this.env.LINUX_CONTAINERS.getByName(hostId);
      const image = await host.preparedImage();
      const imageDigest = image.slice(image.lastIndexOf("@") + 1);
      const prior = await this.ctx.storage.get<RuntimeHostContext>("fortipi-probe-context");
      const context =
        prior ??
        hostContext({
          hostId,
          authorityId: "controlled-probe",
          allocationId: "controlled-probe-allocation",
          childId: probeChildId,
          imageDigest,
          ownershipNonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
        });
      requireThat(
        context.hostId === hostId &&
          context.imageDigest === imageDigest &&
          this.env.WORKSPACES.idFromName(context.childId).equals(this.ctx.id),
        "conflict",
        "Standalone probe context changed; do not infer replacement ownership",
      );
      if (!prior) await this.ctx.storage.put("fortipi-probe-context", context);
      containerHost = new FencedContainerAPI(await host.getWorkspaceContainer(), host, context);
    }
    const backend = linux
      ? new ContainerBackend({
          container: () => {
            const host = containerHost;
            if (!host) throw new Error("Fenced container host required");
            return { getWorkspaceContainer: () => host };
          },
          workspace: { binding: "WORKSPACES", id: this.ctx.id.toString() },
          id: "probe",
          name: "computerd",
          restartAttempts: 0,
          egress: {
            mode: "http-gateway",
            gateway: (
              this.ctx.exports as unknown as {
                ProbeGateway(options: Record<string, never>): Fetcher;
              }
            ).ProbeGateway({}),
          },
          connectTimeoutMs: 20_000,
          healthProbeTimeoutMs: 1000,
        })
      : new CodemodeBackend({
          loader:
            this.env.LOADER ??
            (() => {
              throw new Error("Loader binding required");
            })(),
          id: "probe",
          root: "/workspace",
          access: "read-write",
          modules: {},
          onInterrupt: "fail",
          keepAliveIntervalMs: 0,
          egress: { mode: "none" },
          maxTimeoutMs: 10_000,
          maxStdioBytes: 32768,
        });
    if (backend instanceof ContainerBackend) this.container = backend;
    const ws = new Workspace({
      storage: this.ctx.storage,
      backends: [backend],
      output: { maxBytes: 32768, maxLines: 100, keep: 1 },
    });
    this.workspace = ws;
    await ws.fs.mkdir("/workspace", { recursive: true });
    if (linux && url.searchParams.has("process-group")) {
      const pending = await ws.runtime.exec(
        "set -eu\n(sleep 3; printf orphan > /workspace/pg-survived) &\nprintf ready > /workspace/pg-ready\nwait\n",
        {
          id: "probe-process-group",
          backend: "probe",
          cwd: "/workspace",
          encoding: "utf8",
          onInterrupt: "fail",
          sync: "wait",
          timeoutMs: 10000,
        },
      );
      const terminal = pending.result();
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          if ((await ws.fs.readFile("/workspace/pg-ready", "utf8")) === "ready") break;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (Date.now() >= deadline) throw new Error("Actual process group did not reach readiness");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await ws.runtime.killExec("probe-process-group", { backend: "probe", signal: "SIGTERM" });
      const cancelled = await terminal;
      if (
        cancelled.status !== "cancelled" ||
        cancelled.sync.status !== "complete" ||
        cancelled.skipped.length !== 0
      )
        throw new Error("Cancelled group did not settle with complete scratch synchronization");
      const observer = await ws.runtime.exec(
        "set -eu\nsleep 4\ntest ! -e /workspace/pg-survived\nprintf process-group-stopped\n",
        {
          id: "probe-process-group-observer",
          backend: "probe",
          cwd: "/workspace",
          encoding: "utf8",
          onInterrupt: "fail",
          sync: "wait",
          timeoutMs: 8000,
        },
      );
      const observed = await observer.result();
      if (
        observed.status !== "completed" ||
        observed.exitCode !== 0 ||
        observed.sync.status !== "complete" ||
        observed.skipped.length !== 0
      )
        throw new Error(
          "A descendant survived group cancellation or synchronization was incomplete",
        );
      return Response.json({
        cancelled: cancelled.status,
        observer: observed.status,
        stdout: observed.stdout,
        sync: observed.sync.status,
        skipped: observed.skipped.length,
      });
    }
    await ws.fs.writeFile("/workspace/input.txt", "fortipi-mount-canary", { mode: 420 });
    const source = linux
      ? "set -eu\ncat /workspace/input.txt\nprintf 'fortipi-result' > /workspace/result.txt\ncat /workspace/result.txt\ncat /proc/self/mountinfo\n"
      : "import { readFile, writeFile } from 'node:fs/promises'; export default async function () { console.log(await readFile('/workspace/input.txt','utf8')); await writeFile('/workspace/result.txt','fortipi-result'); console.log(await readFile('/workspace/result.txt','utf8')); }";
    const result = await (async () => {
      const handle = await ws.runtime.exec(source, {
        id: "probe-execution",
        backend: "probe",
        cwd: "/workspace",
        encoding: "utf8",
        onInterrupt: "fail",
        sync: "wait",
        timeoutMs: 10_000,
      });
      return handle.result();
    })().catch((error: unknown) => {
      if (linux)
        console.error(
          `fortipi-container-request-stage:${containerRequestFailureStage(error) ?? "unclassified"}`,
        );
      throw error;
    });
    const content = await ws.fs.readFile("/workspace/result.txt", "utf8");
    const fuse = /\s\/workspace\s.* - fuse(?:\.|\s)/.test(result.stdout);
    if (this.env.REQUIRE_FUSE === "true" && !fuse)
      throw new Error("Real FUSE mount was required but not observed");
    return Response.json({
      status: result.status,
      exitCode: result.exitCode,
      content,
      canary: result.stdout.includes("fortipi-mount-canary"),
      sync: result.sync.status,
      skipped: result.skipped.length,
      fuse,
    });
  }
  async close(): Promise<void> {
    await this.workspace?.close();
    this.workspace = undefined;
    this.container = undefined;
  }
}
export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (new URL(request.url).pathname === "/prepared-image") {
      if (!env.LINUX_CONTAINERS) return new Response(null, { status: 404 });
      return Response.json(
        await env.LINUX_CONTAINERS.getByName(
          linuxHostId("probe", env.WORKSPACES.idFromName(probeChildId).toString()),
        ).preparedImage(),
      );
    }
    return env.WORKSPACES.getByName(probeChildId).fetch(request);
  },
};
