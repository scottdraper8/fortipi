import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { repository } from "../../scripts/build-workspaces.ts";

export function verifyControls(before: number, denied: number, after: number): void {
  assert.equal(before, 0, "Allowed registry control failed before denied probe");
  assert.equal(after, 0, "Allowed registry control failed after denied probe");
  assert.ok(
    denied === 1 || denied === 124,
    "Denied target connected or container/timeout setup failed",
  );
}

const commands = {
  allowed: "exec 3<>/dev/tcp/registry.npmjs.org/443",
  denied: "exec 3<>/dev/tcp/example.com/443",
} as const;

async function main(): Promise<void> {
  assert.equal(process.platform, "linux", "Container egress proof requires actual Linux");
  const metadata = JSON.parse(
    await readFile(`${repository}/apps/worker/dist/container/image-metadata.json`, "utf8"),
  ) as { imageId: string; sourceCommit: string };
  assert.match(metadata.imageId, /^sha256:[a-f0-9]{64}$/);
  const probe = (network: "bridge" | "host", target: keyof typeof commands) =>
    new Promise<number>((accept, reject) => {
      const started = new Date().toISOString();
      execFile(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          network,
          "--read-only",
          "--cap-drop=ALL",
          "--entrypoint",
          "/usr/bin/timeout",
          metadata.imageId,
          "10s",
          "/bin/bash",
          "-c",
          commands[target],
        ],
        {
          env: {
            HOME: process.env.HOME,
            PATH: process.env.PATH,
            DOCKER_HOST: process.env.DOCKER_HOST,
            DOCKER_CONFIG: process.env.DOCKER_CONFIG,
          },
          timeout: 25_000,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024,
        },
        (error) => {
          if (error && (error.killed || typeof error.code !== "number")) {
            reject(
              new Error(`Container ${network}/${target} probe could not execute within its bound`),
            );
            return;
          }
          const exitCode = typeof error?.code === "number" ? error.code : 0;
          console.log(
            JSON.stringify({
              probe: "container-tcp",
              network,
              target,
              port: 443,
              started,
              finished: new Date().toISOString(),
              exitCode,
              imageId: metadata.imageId,
            }),
          );
          accept(exitCode);
        },
      );
    });
  for (const network of ["bridge", "host"] as const) {
    const before = await probe(network, "allowed");
    const denied = await probe(network, "denied");
    const after = await probe(network, "allowed");
    verifyControls(before, denied, after);
    console.log(
      JSON.stringify({
        network,
        imageId: metadata.imageId,
        sourceCommit: metadata.sourceCommit,
        allowedControls: "connected",
        exampleConnection: "refused",
        attribution:
          "Retain and inspect Harden-Runner's example.com:443 blocked-flow event; refusal alone is not firewall attribution",
      }),
    );
  }
}
if (import.meta.main) await main();
