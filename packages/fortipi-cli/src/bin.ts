#!/usr/bin/env node
import { CliError, runCommand } from "./index.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
try {
  const result = await runCommand(process.argv.slice(2), { signal: controller.signal });
  if (controller.signal.aborted) process.exitCode = 130;
  else if (result && typeof result === "object" && "help" in result)
    process.stdout.write(String(result.help));
  else {
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > 1048576) throw new CliError("result_too_large");
    process.stdout.write(`${json}\n`);
    if (result && typeof result === "object" && "exitCode" in result)
      process.exitCode = Number(result.exitCode);
  }
} catch (e) {
  const error = e instanceof CliError ? e : new CliError("command_failed");
  process.stderr.write(`${controller.signal.aborted ? "cancelled" : error.code}\n`);
  process.exitCode = controller.signal.aborted ? 130 : error.exitCode;
}
