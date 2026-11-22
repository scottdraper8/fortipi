import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "fortipi-watermark-fault-"));
try {
  const main = join(directory, "worker.js");
  let changed = 0;
  await build({
    entryPoints: [resolve("apps/worker/test/agent/pi-watermark-worker.ts")],
    outfile: main,
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
        name: "owned-forbidden-raw-outer-transaction",
        setup(builder) {
          builder.onLoad({ filter: /src\/agent\/pi-storage\.ts$/ }, async (args) => {
            const source = await readFile(args.path, "utf8"),
              needle = "return original.commit(batches, receive, context);";
            assert.equal(source.split(needle).length, 2);
            changed++;
            return {
              loader: "ts",
              contents: source.replace(
                needle,
                "return store.storage.transaction(async () => original.commit(batches, receive, context));",
              ),
            };
          });
        },
      },
    ],
  });
  assert.equal(changed, 1);
  const child = spawn(process.execPath, ["--test", "apps/worker/test/agent/pi-watermark.test.ts"], {
    env: {
      PATH: process.env.PATH,
      WRANGLER_SEND_METRICS: "false",
      FORTIPI_PI_WATERMARK_WORKER: main,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += String(data);
  });
  child.stderr.on("data", (data) => {
    output += String(data);
  });
  const exit = await new Promise<number | null>((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
  });
  assert.equal(exit, 1, output);
  assert.match(output, /An acknowledged competing application write must survive/, output);
  assert.doesNotMatch(output, /test timed out|Transform failed|ERR_MODULE_NOT_FOUND/, output);
  console.log(
    "Detected actual acknowledged-write loss from the forbidden raw outer transaction; production unchanged.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
