import test from "node:test";
import { storeRetirement } from "./storage-lifecycle.ts";
import { workspaceAtomicBytes } from "./workspace-portability.ts";

test("real Computer multi-chunk bytes and atomic pointer/receipt survive interrupted staging, lost response and actual runtime death", {
  timeout: 90000,
}, async () => {
  await workspaceAtomicBytes();
});

test("actual Computer retirement observes real cleanup grace and physical relief without losing published bytes", {
  timeout: 140000,
}, async () => {
  await storeRetirement();
});
