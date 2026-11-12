import test from "node:test";
import { runModelsSecurity } from "./cloud-models.ts";

test("real Worker encrypted provider authentication and selected adapter composition", {
  timeout: 180000,
}, async () => {
  const evidence = await runModelsSecurity();
  console.log(JSON.stringify(evidence));
});
