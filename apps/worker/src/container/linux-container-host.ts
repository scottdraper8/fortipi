import { DurableObject } from "cloudflare:workers";
import { WorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import { linuxHostId } from "../backends/linux.js";
import type { Env } from "../boundary/env.js";
import { requireThat } from "../workspace/errors.js";
import { ContainerHostTransport } from "./host-transport.js";

/** Optional paid host. Canonical files and agent state live in separate objects. */
export class LinuxContainerHost extends DurableObject<Env> {
  #transport: ContainerHostTransport | undefined;
  #configuredImage(): string {
    requireThat(
      "execution" in this.env.FORTIPI_CONFIG && this.env.FORTIPI_CONFIG.execution.kind === "linux",
      "unsupported",
      "Linux backend is not selected",
    );
    const configured = this.ctx.container?.images.computerd;
    requireThat(configured, "conflict", "Prepared computerd image is missing");
    requireThat(
      configured.endsWith(`@${this.env.FORTIPI_CONFIG.execution.imageDigest}`),
      "conflict",
      "Prepared computerd image does not match the configured immutable digest",
    );
    return configured;
  }
  #host(): ContainerHostTransport {
    const container = this.ctx.container;
    requireThat(container, "unsupported", "Owning native container context is unavailable");
    this.#transport ??= new ContainerHostTransport(
      this.ctx.storage,
      new WorkspaceContainerAPI(this.ctx),
      () => this.#configuredImage(),
      { inspect: () => container.inspect(), destroy: () => container.destroy() },
      {
        policyVersion: () => this.env.FORTIPI_CONFIG.infrastructure.version,
        validate: (context, activation) => {
          requireThat(
            this.env.LINUX_CONTAINERS?.idFromName(context.hostId).equals(this.ctx.id) &&
              context.hostId.endsWith(
                `:${this.env.WORKSPACES.idFromName(context.childId).toString()}`,
              ),
            "unauthorized",
            "Exact physical Host namespace and child identity required",
          );
          if (activation)
            requireThat(
              "execution" in this.env.FORTIPI_CONFIG &&
                this.env.FORTIPI_CONFIG.execution.kind === "linux" &&
                context.hostId ===
                  linuxHostId(
                    this.env.FORTIPI_CONFIG.execution.host,
                    this.env.WORKSPACES.idFromName(context.childId).toString(),
                  ),
              "conflict",
              "Selected backend does not own this Host context",
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
