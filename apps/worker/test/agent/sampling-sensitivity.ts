import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "fortipi-sample-fault-"));
try {
  const main = join(directory, "worker.js");
  let changed = 0;
  await build({
    entryPoints: [resolve("apps/worker/test/agent/runtime-worker.ts")],
    outfile: main,
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["browser", "module", "main"],
    target: "es2024",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*", ...builtinModules],
    loader: { ".yaml": "json" },
    logLevel: "silent",
    plugins: [
      {
        name: "owned-unsynchronized-physical-observation",
        setup(builder) {
          builder.onLoad({ filter: /src\/agent\/physical-storage\.ts$/ }, async (args) => {
            const source = await readFile(args.path, "utf8");
            assert.equal(source.split("await this.#lanes.run").length, 2);
            assert.equal(source.split("bytes: this.store.physicalBytes()").length, 2);
            changed++;
            return {
              loader: "ts",
              contents: source
                .replace(
                  "await this.#lanes.run",
                  "const unsynchronizedBytes = this.store.physicalBytes(); await this.#lanes.run",
                )
                .replace("bytes: this.store.physicalBytes()", "bytes: unsynchronizedBytes"),
            };
          });
        },
      },
    ],
  });
  assert.equal(changed, 1);
  const child = spawn(
    process.execPath,
    ["--test", "apps/worker/test/agent/physical-storage.test.ts"],
    {
      env: {
        PATH: process.env.PATH,
        WRANGLER_SEND_METRICS: "false",
        FORTIPI_SAMPLE_ORACLE_WORKER: main,
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
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exit, 1, output);
  assert.match(output, /first.coverage.bytes >= result.beforeReport/, output);
  assert.doesNotMatch(output, /test timed out|No matching export|Transform failed/, output);
  console.log("Detected actual pre-queue physical under-observation fault; production unchanged.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
