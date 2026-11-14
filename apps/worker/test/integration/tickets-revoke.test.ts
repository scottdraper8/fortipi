import test from "node:test";
import { fenceGeneration, interruptedRevocation, ticketsAndRevoke } from "./tickets-revoke.ts";

test("actual native tickets consume once and revoke closes the registered stream", {
  timeout: 45000,
}, async () => {
  await ticketsAndRevoke();
});
test("completed recipient generation fences an in-flight actual allowed CP decision", {
  timeout: 45000,
}, async () => {
  await fenceGeneration();
});
test("pending actual revocation survives workerd death until every recipient acknowledges", {
  timeout: 60000,
}, async () => {
  await interruptedRevocation();
});
