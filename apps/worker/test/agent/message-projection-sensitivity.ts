import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "fortipi-message-parts-fault-"));
const faults = [
  {
    name: "lost-part",
    source: "conversations.ts",
    needle: "for (const [index, message] of projected.entries())",
    replacement: "for (const [index, message] of projected.slice(0, 1).entries())",
    file: "apps/worker/test/api/stream-snapshot-wire.test.ts",
    pattern: "real public100KiB Pi answer",
    oracle: /Bounded public parts must reconstruct the exact original answer/,
  },
  {
    name: "split-surrogate",
    source: "message-projection.ts",
    needle: "for (const character of message.content)",
    replacement: 'for (const character of message.content.split(""))',
    file: "apps/worker/test/agent/message-projection.test.ts",
    pattern: "bounded Message parts preserve",
    oracle: /A public part cannot end inside a surrogate pair/,
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
            builder.onLoad(
              { filter: /src\/agent\/(conversations|message-projection)\.ts$/ },
              async ({ path }) => {
                if (!path.endsWith(`/${fault.source}`)) return;
                const source = await readFile(path, "utf8");
                assert.equal(source.split(fault.needle).length, 2);
                changed++;
                return { loader: "ts", contents: source.replace(fault.needle, fault.replacement) };
              },
            );
          },
        },
      ],
    });
    assert.equal(changed, 1);
    const child = spawn(
      process.execPath,
      ["--test", `--test-name-pattern=${fault.pattern}`, fault.file],
      {
        env: { PATH: process.env.PATH, FORTIPI_MESSAGE_PROJECTION_WORKER: outfile },
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
    console.log(`Detected ${fault.name} through exact text/Unicode oracle; production unchanged.`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
