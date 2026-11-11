import { DurableObject } from "cloudflare:workers";
import { withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import type { Env } from "../boundary/env.js";
import { requireThat } from "../workspace/errors.js";

/** Optional paid host. Canonical files and agent state live in separate objects. */
class HostBase extends DurableObject<Env> {}
export class LinuxContainerHost extends withWorkspaceContainer(HostBase) {
  override getWorkspaceContainer() {
    requireThat(
      "execution" in this.env.FORTIPI_CONFIG && this.env.FORTIPI_CONFIG.execution.kind === "linux",
      "unsupported",
      "Linux backend is not selected",
    );
    const configured = this.ctx.container?.images.computerd;
    requireThat(
      configured?.endsWith(`@${this.env.FORTIPI_CONFIG.execution.imageDigest}`),
      "conflict",
      "Prepared computerd image does not match the configured immutable digest",
    );
    return super.getWorkspaceContainer();
  }
}
