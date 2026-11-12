import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "fortipi-stream-faults-"));
const faults = [
  {
    name: "unbounded-lifetime",
    needle:
      /if \(\s*budget.frames \+ 1 >= wireLimits.socketFrames \|\|\s*budget.bytes \+ bytes \+ resyncFrameBytes > wireLimits.socketBytes\s*\)\s*break;/g,
    test: "real socket lifetime bounds",
    oracle: /A lifetime may not exceed(256 frames|1MiB encoded bytes)/,
  },
  {
    name: "stale-publication-authority",
    needle: /if \(current\) await this.authority.current\(current.auth, current.resources\);/g,
    test: "expiry during queued delivery",
    oracle: /Authority expiring during replay must be checked before publication/,
  },
] as const;
try {
  for (const fault of faults) {
    let changed = 0;
    const outfile = join(directory, `${fault.name}.mjs`);
    await build({
      entryPoints: [resolve("apps/worker/test/api/stream-boundaries-worker.ts")],
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
          name: fault.name,
          setup(builder) {
            builder.onLoad({ filter: /src\/agent\/agent-session\.ts$/ }, async ({ path }) => {
              const source = await readFile(path, "utf8");
              assert.equal([...source.matchAll(fault.needle)].length, 1);
              changed++;
              return { loader: "ts", contents: source.replace(fault.needle, "") };
            });
          },
        },
      ],
    });
    assert.equal(changed, 1);
    const child = spawn(
      process.execPath,
      [
        "--test",
        `--test-name-pattern=${fault.test}`,
        "apps/worker/test/api/stream-boundaries.test.ts",
      ],
      {
        env: { PATH: process.env.PATH, FORTIPI_STREAM_TEST_MAIN: outfile },
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
    assert.match(output, fault.oracle, output);
    assert.doesNotMatch(output, /test timed out|Transform failed|ERR_MODULE_NOT_FOUND/, output);
    console.log(`Detected ${fault.name} through actual publication oracle; production unchanged.`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
