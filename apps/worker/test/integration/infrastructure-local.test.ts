import { test } from "node:test";
import { runLocalInfrastructureDetails } from "./infrastructure-local.ts";

test("LOCAL public Computer staging/history and CP retained cleanup preserve bounds, identities and possible effects", {
  timeout: 90000,
}, async () => {
  const observed = await runLocalInfrastructureDetails();
  // Numeric/hashes/public IDs only; never profile/token/request headers.
  console.log(JSON.stringify(observed));
});
