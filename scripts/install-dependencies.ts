// Bootstrap imports only Node builtins: it runs before node_modules exists.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.versions.node, "26.13.0");
assert.equal(
  (await promisify(execFile)("pnpm", ["--version"], { cwd: root, timeout: 30_000 })).stdout.trim(),
  "12.18.0",
);
assert.ok(
  process.argv.slice(2).every((arg) => arg === "--force"),
  "Only optional --force is supported",
);
await new Promise<void>((accept, reject) => {
  const child = spawn("pnpm", ["install", "--frozen-lockfile", ...process.argv.slice(2)], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      npm_config_build_from_source: "true",
      npm_config_node_gyp: resolve(root, "node_modules/node-gyp/bin/node-gyp.js"),
    },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timer);
    if (code === 0) accept();
    else reject(new Error(`Frozen dependency install failed: ${signal ?? code}`));
  });
});
