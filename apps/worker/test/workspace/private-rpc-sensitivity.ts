import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./harness.ts";

const source = resolve(root, "apps/worker/src/workspace/.private-rpc-fault.ts");
const entry = resolve(root, "apps/worker/test/workspace/.private-rpc-worker.ts");
const config = resolve(root, "apps/worker/dist/tsconfig.private-rpc-fault.json");
const ownerTypes = [
  "workspace/local-read",
  "workspace/local-upload",
  "workspace/export",
  "workspace/terminal-proof",
  "backends/ledger",
].map((name) => ({
  source: resolve(root, `apps/worker/src/${name}.ts`),
  target: resolve(root, `apps/worker/src/${name.replace(/([^/]+)$/, ".private-rpc-$1")}.ts`),
}));
const workspace = await readFile(
  resolve(root, "apps/worker/src/workspace/workspace-object.ts"),
  "utf8",
);
const fixture = await readFile(
  resolve(root, "apps/worker/test/workspace/runtime-worker.ts"),
  "utf8",
);
async function run(
  args: string[],
  fault = false,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...(fault ? { FORTIPI_TEST_ENTRY: entry } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (bytes: Buffer) => {
    output += bytes.toString();
  });
  child.stderr.on("data", (bytes: Buffer) => {
    output += bytes.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  return { code, output };
}
await mkdir(resolve(root, "apps/worker/dist"), { recursive: true });
try {
  assert.match(workspace, /#page\b/);
  let changed = workspace.replace(/#page\b/g, "page");
  // Keep one class identity through existing type-only owner links, with no casts or API changes.
  for (const file of ownerTypes) {
    const text = await readFile(file.source, "utf8");
    await writeFile(
      file.target,
      text
        .replaceAll('"./workspace-object.js"', '"./.private-rpc-fault.js"')
        .replaceAll('"../workspace/workspace-object.js"', '"../workspace/.private-rpc-fault.js"'),
    );
    const name = file.source.split("/").at(-1) ?? "";
    changed = changed
      .replace(
        `"./${name.replace(".ts", ".js")}"`,
        `"./.private-rpc-${name.replace(".ts", ".js")}"`,
      )
      .replace(
        `"../backends/${name.replace(".ts", ".js")}"`,
        `"../backends/.private-rpc-${name.replace(".ts", ".js")}"`,
      );
  }
  await writeFile(source, changed);
  await writeFile(
    entry,
    fixture.replace(
      'from "../../src/workspace/workspace-object.js"',
      'from "../../src/workspace/.private-rpc-fault.js"',
    ),
  );
  await writeFile(
    config,
    JSON.stringify({ extends: "../tsconfig.json", include: [], files: [entry] }),
  );
  const compiled = await run([resolve(root, "node_modules/typescript/bin/tsc"), "-p", config]);
  assert.equal(
    compiled.code,
    0,
    `Re-exposure fault did not compile under unchanged Worker strictness: ${compiled.output}`,
  );
  const test = ["--test", resolve(root, "apps/worker/test/workspace/private-rpc.test.ts")];
  const faulty = await run(test, true);
  await writeFile(resolve(root, "apps/worker/dist/private-rpc-fault.log"), faulty.output);
  assert.equal(faulty.code, 1);
  assert.ok(
    faulty.output.includes("Internal WorkspaceObject helper page was exposed over RPC"),
    `Fault did not hit actual RPC exposure oracle: ${faulty.output}`,
  );
  const restored = await run(test);
  assert.equal(
    restored.code,
    0,
    `Protected source did not pass after removing fault lane: ${restored.output}`,
  );
  process.stdout.write(
    "Strictly compiled page re-exposure failed actual RPC oracle; protected source passed\n",
  );
} finally {
  for (const path of [source, entry, config, ...ownerTypes.map((file) => file.target)])
    await unlink(path).catch(() => {});
}
