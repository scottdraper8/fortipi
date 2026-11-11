import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

/** Inject only into disposable OWN source, after a real capacity response. */
export async function capacityBarrierWorker(outfile: string, mode: "crash" | "expiry") {
  let inserted = 0;
  await build({
    entryPoints: [resolve("apps/worker/test/agent/runtime-worker.ts")],
    outfile,
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
        name: "owned-admission-capacity-barrier",
        setup(builder) {
          builder.onLoad({ filter: /src\/agent\/conversations\.ts$/ }, async (args) => {
            const source = await readFile(args.path, "utf8"),
              needle = /const admission: Admission = \{/g;
            assert.equal([...source.matchAll(needle)].length, 1);
            inserted++;
            return {
              loader: "ts",
              contents: source.replace(
                needle,
                `
            if(await store.get("fixture","fault")==="after-capacity") {
              await store.transaction(async tx=>{
                await store.remove("fixture","fault",tx);
                await store.put("fixture","barrier","after-capacity",tx);
              });
              ${mode === "expiry" ? 'check(auth.grants.some(grant=>grant.expiresAt>Date.now()),"conflict","Grant expired before actual capacity return");' : ""}
              await new Promise(accept=>setTimeout(accept,${mode === "crash" ? 300000 : 2500}));
            }
            const admission: Admission = {`,
              ),
            };
          });
        },
      },
    ],
  });
  assert.equal(inserted, 1);
}
