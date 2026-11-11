import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./harness.ts";

const directory = resolve(root, "apps/worker/src/workspace");
const poolPath = resolve(directory, ".storage-fault.ts");
const workspacePath = resolve(directory, ".storage-workspace.ts");
const entry = resolve(root, "apps/worker/test/workspace/.storage-worker.ts");
const controlEntry = resolve(root, "apps/worker/test/workspace/.storage-control-worker.ts");
const config = resolve(root, "apps/worker/dist/tsconfig.storage-fault.json");
const ownerTypes = [
  "workspace/local-read",
  "workspace/local-upload",
  "workspace/export",
  "workspace/terminal-proof",
  "backends/ledger",
].map((name) => ({
  source: resolve(root, `apps/worker/src/${name}.ts`),
  target: resolve(root, `apps/worker/src/${name.replace(/([^/]+)$/, ".storage-$1")}.ts`),
}));
const pool = await readFile(resolve(directory, "storage.ts"), "utf8");
const workspace = await readFile(resolve(directory, "workspace-object.ts"), "utf8");
const fixture = await readFile(
  resolve(root, "apps/worker/test/workspace/runtime-worker.ts"),
  "utf8",
);
async function run(args: string[], faulty = false) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      ...(faulty ? { FORTIPI_TEST_ENTRY: entry, FORTIPI_STORAGE_CONTROL_ENTRY: controlEntry } : {}),
    },
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
  let source = workspace.replace('"./storage.js"', '"./.storage-fault.js"');
  for (const file of ownerTypes) {
    const content = (await readFile(file.source, "utf8"))
      .replaceAll('"./workspace-object.js"', '"./.storage-workspace.js"')
      .replaceAll('"../workspace/workspace-object.js"', '"../workspace/.storage-workspace.js"')
      .replaceAll('"./storage.js"', '"./.storage-fault.js"')
      .replaceAll('"../workspace/storage.js"', '"../workspace/.storage-fault.js"');
    await writeFile(file.target, content);
    const name = file.source.split("/").at(-1)?.replace(".ts", ".js");
    source = source
      .replace(`"./${name}"`, `"./.storage-${name}"`)
      .replace(`"../backends/${name}"`, `"../backends/.storage-${name}"`);
  }
  await writeFile(workspacePath, source);
  await writeFile(
    entry,
    fixture
      .replace(
        '"../../src/workspace/workspace-object.js"',
        '"../../src/workspace/.storage-workspace.js"',
      )
      .replace('"../../src/workspace/storage.js"', '"../../src/workspace/.storage-fault.js"'),
  );
  await writeFile(
    controlEntry,
    (
      await readFile(resolve(root, "apps/worker/test/workspace/storage-control-worker.ts"), "utf8")
    ).replace(
      '"../../src/workspace/workspace-object.js"',
      '"../../src/workspace/.storage-workspace.js"',
    ),
  );
  await writeFile(
    config,
    JSON.stringify({ extends: "../tsconfig.json", include: [], files: [entry, controlEntry] }),
  );
  const hosts = process.argv.includes("--hosts");
  const faults = hosts
    ? (["host-copies", "host-credit"] as const)
    : (["pending", "copies", "survey", "activation", "settlement"] as const);
  for (const fault of faults) {
    const changed =
      fault === "host-copies"
        ? pool.replace("Object.values(hosts).reduce((sum, bytes) => sum + bytes, 0)", "0")
        : fault === "host-credit"
          ? pool.replace("unspent += metadataCredit;", "// Missing Host metadata growth coverage")
          : fault === "pending"
            ? pool.replace("uploadOperation &&", "true &&")
            : fault === "copies"
              ? pool.replace(
                  /observed \+= owner\.state\.get<number>\(`storage-observed:\$\{allocation.childId\}`\) \?\? 0;/,
                  "observed += 0;",
                )
              : fault === "survey"
                ? pool.replace("this.survey() === before", "true")
                : fault === "settlement"
                  ? pool.replace(
                      "await this.settleCompleted(ctx);",
                      "// Missing completion settlement",
                    )
                  : pool.replace(
                      /this\.owner\.state\.get\((`storage-initialized:[^`]+`)\)/g,
                      "(this.owner.state.get($1) ?? true)",
                    );
    assert.notEqual(changed, pool, `Fault did not apply: ${fault}`);
    await writeFile(
      poolPath,
      changed.replaceAll('"./workspace-object.js"', '"./.storage-workspace.js"'),
    );
    const compiled = await run([resolve(root, "node_modules/typescript/bin/tsc"), "-p", config]);
    assert.equal(
      compiled.code,
      0,
      `Fault failed unchanged strict Worker compile: ${compiled.output}`,
    );
    const pattern = hosts
      ? "Workspace census counts Host"
      : fault === "pending"
        ? "unknown actual Loader"
        : fault === "activation"
          ? "physical census preserves"
          : fault === "settlement"
            ? "real CP completion"
            : "independent retained copies";
    const result = await run(
      [
        "--test",
        `--test-name-pattern=${pattern}`,
        resolve(
          root,
          `apps/worker/test/workspace/${hosts ? "host-storage" : fault === "settlement" ? "storage-settlement" : "storage"}.test.ts`,
        ),
      ],
      true,
    );
    assert.notEqual(result.code, 0, `Storage fault escaped actual runtime oracle: ${fault}`);
    assert.match(
      result.output,
      /AssertionError/,
      `Fault failed outside the behavioral oracle: ${result.output}`,
    );
    console.log(`Actual storage sensitivity rejected ${fault}`);
  }
} finally {
  await Promise.all(
    [
      poolPath,
      workspacePath,
      entry,
      controlEntry,
      config,
      ...ownerTypes.map((file) => file.target),
    ].map((path) => unlink(path).catch(() => {})),
  );
}
