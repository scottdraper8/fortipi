import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "fortipi-resume-fault-"));
try {
  const outfile = join(directory, "worker.mjs");
  let changes = 0;
  await build({
    entryPoints: [resolve("apps/worker/test/agent/resume-settlement-worker.ts")],
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
        name: "owned-resume-before-ack-fault",
        setup(builder) {
          builder.onLoad({ filter: /src\/agent\/controls\.ts$/ }, async (args) => {
            const source = await readFile(args.path, "utf8");
            const needle = 'admission.state === "settled",';
            assert.equal(source.split(needle).length, 3);
            changes++;
            return { loader: "ts", contents: source.replaceAll(needle, "true,") };
          });
        },
      },
    ],
  });
  assert.equal(changes, 1);
  const child = spawn(
    process.execPath,
    ["--test", "apps/worker/test/agent/resume-settlement.test.ts"],
    {
      env: { PATH: process.env.PATH, FORTIPI_RESUME_FAULT_WORKER: outfile },
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
  assert.match(output, /Unacknowledged prior settlement must block new resume work/, output);
  assert.doesNotMatch(output, /test timed out|Transform failed|ERR_MODULE_NOT_FOUND/, output);
  console.log("Detected resume growth before prior consumed ACK; production unchanged.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
