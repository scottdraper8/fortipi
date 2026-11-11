import test from "node:test";
import { storageAccounting } from "./storage-accounting-oracle.ts";

test(
  "install storage charge covers actual Agent baseline and small-input/large-answer persistence",
  {
    timeout: 45000,
  },
  () => storageAccounting(),
);
