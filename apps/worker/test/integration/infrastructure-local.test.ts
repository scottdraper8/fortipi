import { test } from "node:test";
import { runLocalInfrastructureDetails } from "./infrastructure-local.ts";

test("LOCAL public Computer/SQLite staging/history preserve bounded bytes and refusal identity", {
  timeout: 90000,
}, async () => {
  const observed = await runLocalInfrastructureDetails();
  // Numeric/hashes/public IDs only; never profile/token/request headers.
  console.log(JSON.stringify(observed));
});
