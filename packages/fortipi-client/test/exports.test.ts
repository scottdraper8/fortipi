import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

void test("actual browser package exports bundle without Node modules; importing native performs no acquisition", async () => {
  const result = await build({
    stdin: {
      contents: "export { FortiPiClient } from 'fortipi-client/browser'",
      resolveDir: import.meta.dirname,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    metafile: true,
  });
  assert(result.outputFiles[0]?.text.includes("FortiPiClient"));
  assert(
    !Object.keys(result.metafile.inputs).some((name) =>
      /(?:node:|pi-durable|wrangler|fortipi-worker)/.test(name),
    ),
  );
  const main = await import("fortipi-client");
  const native = await import("fortipi-client/node");
  assert.equal(typeof main.FortiPiClient, "function");
  assert.equal(typeof native.FortiPiClient, "function");
});
