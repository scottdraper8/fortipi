import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { build } from "esbuild";

async function checkComplete(fault = false) {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-complete-bound-"));
  try {
    const outfile = join(directory, "oracle.mjs");
    await build({
      entryPoints: [resolve("apps/worker/test/agent/complete-bound-oracle.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      plugins: fault
        ? [
            {
              name: "owned-missing-models-final-handoff",
              setup(builder) {
                builder.onLoad({ filter: /src\/models\/bounded\.ts$/ }, async (args) => {
                  const source = await readFile(args.path, "utf8"),
                    needle = "if (!this.#registries.has(models)) {";
                  assert.equal(source.split(needle).length, 2);
                  return { loader: "ts", contents: source.replace(needle, "if (false) {") };
                });
              },
            },
          ]
        : [],
    });
    let output = "";
    const exit = await new Promise<number | null>((accept, reject) => {
      const child = spawn(process.execPath, ["--test", outfile], {
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) => {
        output += String(data);
      });
      child.stderr.on("data", (data) => {
        output += String(data);
      });
      child.once("error", reject);
      child.once("exit", accept);
    });
    assert.equal(exit, fault ? 1 : 0, output);
    if (fault) {
      assert.match(output, /must abort a stalled final-handoff backlog/, output);
      assert.doesNotMatch(output, /test timed out|ERR_MODULE_NOT_FOUND|Transform failed/, output);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("compiled pinned Models stalled-complete oracle", () => checkComplete());
test("a missing public Models final handoff fails the actual stalled-complete oracle", () =>
  checkComplete(true));
