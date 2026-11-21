import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertDispatchSafe } from "./native-process.ts";

test("SAFE guard scopes the literal dispatch definition and refuses policy or name overrides", async () => {
  assertDispatchSafe(await readFile("apps/worker/src/execution/registry.ts", "utf8"));
  const safe = 'defineTool({name:"fortipi_dispatch",replay:"safe"})';
  assertDispatchSafe(safe);
  assertDispatchSafe(`defineTool({name:"read_context",replay:"unsafe"}); ${safe}`);
  for (const source of [
    'defineTool({name:"fortipi_dispatch",replay:"safe",get replay(){return "unsafe"}})',
    'defineTool({name:"fortipi_dispatch",name:"different_tool",replay:"safe"})',
    'defineTool({name:"fortipi_dispatch",replay:"unsafe"})',
    'defineTool({name:"fortipi_dispatch",replay:"safe",...override})',
    'defineTool({name:"fortipi_dispatch",replay:"safe",[policy]:"unsafe"})',
  ])
    assert.throws(() => assertDispatchSafe(source), { code: "ERR_ASSERTION" });
});
