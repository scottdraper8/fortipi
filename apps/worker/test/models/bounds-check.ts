import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { build } from "esbuild";

const parent = resolve(".agent-docs/tmp/big-build");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "model-bounds-"));
try {
  if (!process.argv.includes("--faults")) {
    const outfile = join(directory, "contract.mjs");
    await build({
      entryPoints: [resolve("apps/worker/test/models/bounds-contract.test.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    process.exitCode = await new Promise<number>((accept, reject) => {
      const child = spawn(process.execPath, ["--test", outfile], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) => accept(code ?? 1));
    });
  } else {
    for (const fault of [
      "snapshot-alias",
      "slot-release",
      "work-limit",
      "tool-arguments",
    ] as const) {
      const worker = fault === "tool-arguments",
        outfile = join(directory, `${fault}.${worker ? "js" : "mjs"}`);
      let mutations = 0;
      await build({
        entryPoints: [
          resolve(
            `apps/worker/test/models/${worker ? "bounds-worker.ts" : "bounds-contract.test.ts"}`,
          ),
        ],
        outfile,
        bundle: true,
        platform: worker ? "neutral" : "node",
        format: "esm",
        logLevel: "silent",
        ...(worker
          ? {
              mainFields: ["browser", "module", "main"],
              conditions: ["workerd", "worker", "browser"],
              external: ["cloudflare:*", "node:*", ...builtinModules],
              loader: { ".yaml": "json" as const },
            }
          : {}),
        plugins: [
          {
            name: "owned-bounds-fault",
            setup(builder) {
              builder.onLoad({ filter: /src\/models\/bounded\.ts$/ }, async (args) => {
                let contents = await readFile(args.path, "utf8");
                const [needle, replacement] = {
                  "snapshot-alias": ["return JSON.parse(encoded) as T;", "return value;"],
                  "slot-release": ["if (terminal || !source) release();", "if (true) release();"],
                  "work-limit": [
                    "this.#limits.encodedWorkBytes - this.#work",
                    "Number.MAX_SAFE_INTEGER",
                  ],
                  "tool-arguments": [
                    "this.#limits.toolArgumentsBytes",
                    "this.#limits.messageBytes",
                  ],
                }[fault];
                assert.ok(needle && replacement);
                const found = contents.split(needle).length - 1;
                assert.equal(found, worker ? 3 : 1);
                contents = contents.replaceAll(needle, replacement);
                mutations++;
                return { contents, loader: "ts" };
              });
            },
          },
        ],
      });
      assert.equal(mutations, 1);
      const pattern =
        fault === "snapshot-alias"
          ? "forwarded progress"
          : fault === "slot-release"
            ? "cancelled provider cleanup"
            : "finite encoded work";
      let output = "",
        code = 0;
      try {
        const result = await promisify(execFile)(
          process.execPath,
          worker
            ? ["--test", "apps/worker/test/models/bounds.test.ts"]
            : ["--test", `--test-name-pattern=${pattern}`, outfile],
          {
            env: {
              PATH: process.env.PATH,
              ...(worker ? { FORTIPI_T5_BOUNDS_WORKER: outfile } : {}),
            },
            timeout: 55000,
            maxBuffer: 256000,
          },
        );
        output = result.stdout;
      } catch (error) {
        const failed = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
        assert.equal(failed.killed, false, "A timeout is not fault evidence");
        code = failed.code ?? -1;
        output = (failed.stdout ?? "") + (failed.stderr ?? "");
      }
      assert.equal(code, 1, `${fault}: behavioral regression must fail`);
      assert.ok(output.includes("AssertionError"), output);
      const evidence =
        fault === "snapshot-alias"
          ? "Provider mutation cannot change an accepted snapshot"
          : fault === "slot-release"
            ? '"replacementStarts":1,"slotRetained":false'
            : fault === "work-limit"
              ? '"workLimited":false'
              : '"kind":"tool"';
      assert.ok(output.includes(evidence), output);
      if (worker) {
        const proof = output.split("\n").flatMap((line) => {
          try {
            const value: unknown = JSON.parse(line);
            return value && typeof value === "object" && "kind" in value && value.kind === "tool"
              ? [value]
              : [];
          } catch {
            return [];
          }
        })[0];
        assert.ok(
          proof && "containsLargeData" in proof && proof.containsLargeData === true,
          "Fault must persist the rejected tool payload, not only an unrelated large positive answer",
        );
        assert.ok(
          "maxAssistantBytes" in proof &&
            typeof proof.maxAssistantBytes === "number" &&
            proof.maxAssistantBytes > 65536,
        );
      }
      console.log(JSON.stringify({ fault, actualBehavioralFailure: true }));
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
