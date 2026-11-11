import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const [mode, path, ...args] = process.argv.slice(2);
if (mode === "append" && path) {
  appendFileSync(path, "effect\n");
  process.stdout.write(args.join("|"));
} else if (mode === "append-wait" && path) {
  appendFileSync(path, "effect\n");
  setTimeout(() => process.exit(0), 2000);
} else if (mode === "environment" && path) {
  writeFileSync(
    path,
    JSON.stringify({
      canary: process.env.FORTIPI_EXECUTOR_SYNTHETIC_CANARY ?? null,
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      systemRoot: process.env.SystemRoot ?? null,
      args,
    }),
  );
} else if (mode === "tree" && path) {
  spawn(process.execPath, [import.meta.filename, "heartbeat", path], { stdio: "inherit" });
  setInterval(() => {}, 1000);
} else if (mode === "heartbeat" && path) {
  setInterval(() => appendFileSync(path, "tick\n"), 30);
} else if (mode === "wait") {
  setInterval(() => {}, 1000);
} else if (mode === "output") {
  process.stdout.write("λ".repeat(50000));
  process.stderr.write("stderr-marker");
} else throw new Error("unknown synthetic child mode");
