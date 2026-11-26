import test from "node:test";
import { observeNativeEvidenceFailure } from "./native-evidence-observation.ts";

test("native platform source port enforces filesystem, SQLite, argv and process-tree oracles", async () => {
  let module: typeof import("../../packages/fortipi-executor/dist/index.js");
  let scenario: typeof import("./native-matrix.ts");
  try {
    module = await import("../../packages/fortipi-executor/dist/index.js");
    scenario = await import("./native-matrix.ts");
  } catch (error) {
    observeNativeEvidenceFailure("platform-source-module", error);
    throw Error("Native platform source scenario failed");
  }
  try {
    await scenario.nativePlatformPort(module);
  } catch {
    throw Error("Native platform source scenario failed");
  }
});
