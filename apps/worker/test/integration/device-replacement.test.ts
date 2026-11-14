import test from "node:test";
import { deviceReplacement } from "./device-replacement.ts";

test("fresh native B continues the same conversation from Computer after A's entire disk and execution authority are removed", {
  timeout: 180000,
}, async () => {
  await deviceReplacement();
});
