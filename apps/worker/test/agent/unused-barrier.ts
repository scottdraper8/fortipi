import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

/** Stops only disposable OWN code after real unused/0 CP ACK, before local ACK. */
export async function unusedBarrierWorker(outfile: string, fault = false) {
  let changes = 0;
  await build({
    entryPoints: [resolve("apps/worker/test/agent/runtime-worker.ts")],
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
        name: "owned-unused-settlement-barrier",
        setup(builder) {
          builder.onLoad({ filter: /src\/agent\/conversations\.ts$/ }, async (args) => {
            let source = await readFile(args.path, "utf8");
            const needle =
              "      await store.transaction(async (tx) => {\n        await authority.current(auth, resources, tx);\n        rejection.acknowledged = true;";
            assert.equal(source.split(needle).length, 2);
            changes++;
            source = source.replace(
              needle,
              `
          if(await store.get("fixture","fault")==="after-unused-ack") {
            await store.transaction(async tx=>{await store.remove("fixture","fault",tx);await store.put("fixture","barrier","after-unused-ack",tx);});
            await new Promise(accept=>setTimeout(accept,300000));
          }
        ${needle}`,
            );
            if (fault) {
              const call = "await authority.control.settleCapacity(auth, {";
              assert.equal(source.split(call).length, 2);
              source = source.replace(
                call,
                'await (async (_auth: D.AuthContext, _input: unknown) => ({ok:true as const,value:{...admission.capacity,state:"settled" as const}}))(auth, {',
              );
            }
            return { loader: "ts", contents: source };
          });
        },
      },
    ],
  });
  assert.equal(changes, 1);
}
