import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";

const child = spawn(
  process.execPath,
  ["--test", "apps/worker/test/agent/unused-recovery.test.ts"],
  {
    env: {
      PATH: process.env.PATH,
      WRANGLER_SEND_METRICS: "false",
      FORTIPI_UNUSED_PROOF_FAULT: "1",
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
const exit = await new Promise<number | null>((accept, reject) => {
  child.once("error", reject);
  child.once("exit", accept);
});
assert.equal(exit, 1, output);
assert.match(output, /A reusable rejected request must reclaim the original Free slot/, output);
assert.doesNotMatch(output, /test timed out|Transform failed|ERR_MODULE_NOT_FOUND/, output);
console.log(
  "Detected fabricated unused settlement: the real Free slot remains held; production unchanged.",
);
