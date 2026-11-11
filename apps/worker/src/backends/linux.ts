import { ContainerBackend } from "@cloudflare/computer/backends/container";
import { requireCapability } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { FencedContainerAPI } from "../container/host-adapter.js";
import { requireThat } from "../workspace/errors.js";

export async function linux(
  env: Env,
  deploymentId: string,
  scratchId: string,
  config: Extract<D.BackendConfig, { kind: "linux" }>,
): Promise<{ backend: ContainerBackend; host: FencedContainerAPI }> {
  requireThat(
    env.LINUX_CONTAINERS &&
      requireCapability(env.FORTIPI_CONFIG.infrastructure, "containers", deploymentId),
    "unsupported",
    "Select and verify the paid Containers capability",
    {
      requiredCapability: "containers",
      setup:
        "Configure LinuxContainerHost with durable_object scheduling and images.computerd bound to the verified image",
    },
  );
  requireThat(
    /^sha256:[a-f0-9]{64}$/.test(config.imageDigest),
    "invalid_request",
    "An immutable built image digest is required",
  );
  requireThat(
    config.runtime.memoryBytes >= 256 * 1024 * 1024 &&
      config.runtime.cpuMs > 0 &&
      config.runtime.timeoutMs > 0,
    "unsupported",
    "The selected Linux image requires at least the supported lite instance memory; execution bounds must be positive",
  );
  const stub = env.LINUX_CONTAINERS.get(
    env.LINUX_CONTAINERS.idFromName(linuxHostId(config.host, scratchId)),
  );
  const host = new FencedContainerAPI(await stub.getWorkspaceContainer(), stub);
  return {
    host,
    backend: new ContainerBackend({
      id: config.backendId,
      container: () => ({ getWorkspaceContainer: () => host }),
      workspace: { binding: "WORKSPACES", id: scratchId },
      name: "computerd",
      instance: "lite",
      egress: { mode: "none" },
      containerEnv: {},
      connectTimeoutMs: 20_000,
      healthProbeTimeoutMs: 1000,
      healthRetryInitialDelayMs: 50,
      healthRetryMaxDelayMs: 500,
      heartbeatIntervalMs: 10_000,
      restartAttempts: 0,
    }),
  };
}
export function linuxHostId(host: string, scratchId: string): string {
  return `fortipi:linux:${host}:${scratchId}`;
}
