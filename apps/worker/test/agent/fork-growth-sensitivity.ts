import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "fortipi-fork-fault-"));
try {
  const faults = ["small-reservation", "creation-poll", "busy-repair"] as const;
  const requested = process.argv[2];
  assert.ok(!requested || faults.some((fault) => fault === requested));
  for (const fault of faults) {
    if (requested && fault !== requested) continue;
    const small = fault === "small-reservation";
    const repair = fault === "busy-repair";
    const outfile = join(directory, `${fault}.mjs`);
    let changes = 0;
    await build({
      entryPoints: [
        resolve(
          small || repair
            ? "apps/worker/test/agent/fork-growth-worker.ts"
            : "apps/worker/test/agent/admission-backoff-worker.ts",
        ),
      ],
      outfile,
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2024",
      mainFields: ["browser", "module", "main"],
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*", ...builtinModules],
      loader: { ".yaml": "json" },
      logLevel: "silent",
      plugins: [
        {
          name: "owned-fork-budget-fault",
          setup(builder) {
            builder.onLoad(
              { filter: /src\/(agent\/(conversations|projection)|api\/common)\.ts$/ },
              async (args) => {
                const source = await readFile(args.path, "utf8");
                if (small && args.path.endsWith("/conversations.ts")) {
                  const needle = "bytes: intent.growthBytes,";
                  assert.equal(source.split(needle).length, 2);
                  changes++;
                  return { loader: "ts", contents: source.replace(needle, "bytes: 4096,") };
                }
                if (!small && !repair && args.path.endsWith("/conversations.ts")) {
                  const needle = "const retryAt = repairRetryAt(error);";
                  assert.equal(source.split(needle).length, 2);
                  changes++;
                  return {
                    loader: "ts",
                    contents: source.replace(
                      needle,
                      needle.replace("repairRetryAt(error)", "Date.now() + 30000"),
                    ),
                  };
                }
                if (repair && args.path.endsWith("/common.ts")) {
                  const needle = "return this.tails.has(key);";
                  assert.equal(source.split(needle).length, 2);
                  changes++;
                  return { loader: "ts", contents: source.replace(needle, "return false;") };
                }
              },
            );
          },
        },
      ],
    });
    assert.equal(changes, 1);
    const child = spawn(
      process.execPath,
      [
        "--test",
        small
          ? "apps/worker/test/agent/fork-growth.test.ts"
          : repair
            ? "apps/worker/test/agent/fork-copy-recovery.test.ts"
            : "apps/worker/test/agent/creation-backoff.test.ts",
      ],
      {
        env: {
          PATH: process.env.PATH,
          ...(small || repair
            ? { FORTIPI_FORK_GROWTH_FAULT_WORKER: outfile }
            : { FORTIPI_CREATION_RETRY_FAULT_WORKER: outfile }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      output += String(data);
    });
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("exit", accept);
    });
    assert.equal(code, 1, output);
    assert.match(
      output,
      small
        ? /Fork growth must account for copied public Pi history/
        : repair
          ? /Known\/publication reads must return while creation remains held/
          : /Direct creation failure must persist its hard hold before returning/,
      output,
    );
    assert.doesNotMatch(output, /test timed out|Transform failed|ERR_MODULE_NOT_FOUND/, output);
    console.log(`Detected ${fault}; production unchanged.`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
