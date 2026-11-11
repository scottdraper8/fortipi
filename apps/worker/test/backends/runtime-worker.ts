import { DurableObject } from "cloudflare:workers";
import { Workspace, WorkspaceProxy } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { ContainerBackend, WorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import {
  containerRequestFailureStage,
  FencedContainerAPI,
} from "../../src/container/host-adapter.js";
import { ContainerHostTransport } from "../../src/container/host-transport.js";

export { WorkspaceProxy };

export class ProbeHost extends DurableObject {
  #transport: ContainerHostTransport | undefined;
  preparedImage(): string {
    const image = this.ctx.container?.images.computerd;
    if (!image) throw new Error("Prepared computerd image required");
    return image;
  }
  #host(): ContainerHostTransport {
    this.#transport ??= new ContainerHostTransport(
      this.ctx.storage,
      new WorkspaceContainerAPI(this.ctx),
      () => this.preparedImage(),
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
    let containerHost: FencedContainerAPI | undefined;
    if (linux) {
      if (!this.env.LINUX_CONTAINERS) throw new Error("Container binding required");
      containerHost = new FencedContainerAPI(
        await this.env.LINUX_CONTAINERS.getByName("probe-host").getWorkspaceContainer(),
        this.env.LINUX_CONTAINERS.getByName("probe-host"),
      );
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
          egress: { mode: "none" },
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
      return Response.json(await env.LINUX_CONTAINERS.getByName("probe-host").preparedImage());
    }
    return env.WORKSPACES.getByName("backend-probe").fetch(request);
  },
};
