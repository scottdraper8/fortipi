import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { boundedBytes } from "./admin.js";
import type { PrepareReceipt } from "./assets.js";
import { sha256, verifyAssets, verifyPrepared } from "./assets.js";
import { CliError, check } from "./errors.js";
import { profileRoot, protectDirectory, reserveProtected } from "./profiles.js";
import type { CommandResult, DeploymentReceipt } from "./results.js";
import { localBootstrap } from "./setup.js";
import type { WranglerPort } from "./wrangler.js";
import { secretPut, wrangler } from "./wrangler.js";

export function deploymentReceipt(jsonl: string, prepared: PrepareReceipt): DeploymentReceipt {
  check(Buffer.byteLength(jsonl) <= 1048576, "deployment_output_too_large", 1);
  let records: Record<string, unknown>[];
  try {
    records = jsonl
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    throw new CliError("invalid_deployment_record");
  }
  const deployments = records.filter((r) => r.type === "deploy");
  const d = deployments[0];
  check(
    deployments.length === 1 &&
      d &&
      d.version === 1 &&
      d.worker_name === prepared.operator.deployment.name &&
      typeof d.version_id === "string" &&
      /^[a-f0-9-]{36}$/.test(d.version_id) &&
      Array.isArray(d.targets) &&
      d.targets.length === 1 &&
      typeof d.targets[0] === "string",
    "ambiguous_deployment_record",
    1,
  );
  const target = d.targets[0] as string;
  check(
    target === prepared.operator.deployment.origin ||
      `https://${target}` === prepared.operator.deployment.origin,
    "deployment_target_mismatch",
    1,
  );
  return {
    workerName: d.worker_name,
    origin: prepared.operator.deployment.origin,
    targets: d.targets,
    workerVersionId: d.version_id,
    sourceCommit: prepared.sourceCommit,
    packageVersion: prepared.packageVersion,
    assetManifestSha256: prepared.assetManifestSha256,
    configSha256: prepared.configSha256,
  };
}
export interface DeployOptions {
  dryRun?: boolean;
  bootstrap?: "local" | "existing";
  nonInteractive?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  profileName?: string;
  profileDirectory?: string;
  transport?: typeof fetch;
}
export async function deploy(
  directory: string,
  options: DeployOptions = {},
  port: WranglerPort = wrangler,
): Promise<CommandResult> {
  directory = resolve(directory);
  const prepared = await verifyPrepared(directory);
  const scratch = join(await realpath(tmpdir()), `fortipi-deploy-${randomUUID()}`);
  await protectDirectory(scratch);
  try {
    const args = ["deploy", "--config", join(directory, "wrangler.json")];
    if (options.dryRun) {
      await port.run({
        cwd: directory,
        args: [...args, "--dry-run", "--outdir", join(scratch, "build")],
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: options.timeoutMs ?? 120000,
      });
      // The prepared template uses no_bundle: true. Verify actual emitted bytes,
      // rather than interpreting a zero exit status as complete module output.
      const assets = await verifyAssets(join(directory, "assets"));
      for (const record of assets.manifest.files.filter((file) => file.kind === "worker")) {
        const emitted = join(scratch, "build", record.path.slice("worker/".length));
        let valid = false;
        try {
          const stat = await lstat(emitted);
          valid =
            stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.size === record.size &&
            sha256(await readFile(emitted)) === record.sha256;
        } catch {}
        check(valid, "wrangler_dry_build_module_identity_failed", 1);
      }
      return {
        state: "dry-build-completed",
        sourceCommit: prepared.sourceCommit,
        assetManifestSha256: prepared.assetManifestSha256,
        workerBytesVerified: true,
      };
    }
    let token: string | undefined;
    if (options.bootstrap === "existing") {
      // Trusted CI supplies exactly this value. It never goes to disk, child env, argv, or results.
      token = process.env.FORTIPI_ADMIN_TOKEN;
      check(
        typeof token === "string" &&
          Buffer.byteLength(token) >= 32 &&
          token.length <= 16384 &&
          !/[\r\n]/.test(token),
        "existing_bootstrap_required",
        3,
      );
    } else {
      const root = options.profileDirectory ?? profileRoot();
      await protectDirectory(root);
      token = (
        await localBootstrap(
          root,
          prepared.operator.deployment.origin,
          options.profileName ?? "default",
        )
      ).token;
    }
    try {
      await secretPut(port, directory, "FORTIPI_ADMIN_TOKEN", {
        input: token,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } finally {
      token = undefined;
    }
    const outputFile = join(scratch, "wrangler-output.jsonl");
    await (await reserveProtected(outputFile)).close();
    await port.run({
      args,
      cwd: directory,
      deploymentAuth: true,
      outputFile,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: options.timeoutMs ?? 120000,
    });
    const receipt = deploymentReceipt(await readFile(outputFile, "utf8"), prepared);
    try {
      const signal = AbortSignal.any([
        AbortSignal.timeout(options.timeoutMs ?? 30000),
        ...(options.signal ? [options.signal] : []),
      ]);
      const response = await (options.transport ?? fetch)(
        `${prepared.operator.deployment.origin}/health`,
        {
          redirect: "error",
          signal,
        },
      );
      check(response.status === 200, "deployed_health_failed", 1);
      const health = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 4096))) as {
        status?: unknown;
        protocolVersion?: unknown;
      };
      check(
        health.status === "ok" && health.protocolVersion === "1.0",
        "deployed_protocol_mismatch",
        1,
      );
    } catch {
      throw new CliError("deployment_health_uncertain");
    }
    return receipt;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
