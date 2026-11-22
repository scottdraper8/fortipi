import test from "node:test";
import { storageAccounting } from "./storage-accounting-oracle.ts";

test(
  "explicit256B progress preserves the public100KiB answer and real physical accounting",
  {
    timeout: 45000,
  },
  () => storageAccounting(256),
);
