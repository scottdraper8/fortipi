import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { requireCapability } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { requireThat } from "../workspace/errors.js";

export function codemode(
  env: Env,
  deploymentId: string,
  config: Extract<D.BackendConfig, { kind: "cloud-js" }>,
): CodemodeBackend {
  requireThat(
    env.LOADER && requireCapability(env.FORTIPI_CONFIG.infrastructure, "loader", deploymentId),
    "unsupported",
    "Select and verify the paid Loader capability",
    {
      requiredCapability: "loader",
      setup: "Enable an account/deployment-bound Loader binding and verified paid capability",
    },
  );
  requireThat(
    config.modules.length === 0 && config.egress.length === 0 && config.onInterrupt === "fail",
    "unsupported",
    "Additional modules and network grants require an explicit reviewed adapter",
  );
  const bounds = env.FORTIPI_CONFIG.infrastructure.bounds;
  return new CodemodeBackend({
    loader: env.LOADER,
    id: config.backendId,
    root: "/workspace",
    access: "read-write",
    modules: {},
    egress: { mode: "none" },
    onInterrupt: "fail",
    keepAliveIntervalMs: 0,
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 30_000,
    maxCpuMs: 10_000,
    maxSourceBytes: 65_536,
    maxInputBytes: 65_536,
    maxStdinBytes: 1,
    maxEnvBytes: 1,
    maxResultBytes: bounds.inlineTailBytes,
    maxStdioBytes: Math.max(1, Math.floor(bounds.outputBytesPerJob / 2)),
    maxCapabilityBytes: 262144,
    maxHostCallMs: 10_000,
    maxConcurrentCapabilityCalls: 4,
    maxCapabilityCalls: 1024,
    maxCapabilityRequestBytes: 262144,
    maxCapabilityResponseBytes: 262144,
    maxDirectoryEntries: bounds.manifestEntries,
    maxExecutionSubscribers: 2,
    retentionMs: 3_600_000,
    maxRetainedExecutions: 1,
    compatibilityDate: "2026-11-10",
    compatibilityFlags: ["nodejs_compat"],
  });
}
