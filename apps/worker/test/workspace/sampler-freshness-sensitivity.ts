import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./harness.ts";

// Run alone: these reversible faults touch ONLY this isolated tree's owned sampler.
const path = resolve(root, "apps/worker/src/workspace/storage.ts");
const backup = resolve(root, "apps/worker/dist/sampler-storage-backup.txt");
const original = await readFile(path, "utf8");
async function run(args: string[]) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
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
await writeFile(backup, original);
try {
  for (const fault of ["time", "ordering", "age", "sender"] as const) {
    const unsafe =
      fault === "sender"
        ? execFileSync(
            "git",
            [
              "show",
              "7eba9bdd29b3607784e54f0143a4c0add2d4630d:apps/worker/src/workspace/storage.ts",
            ],
            { cwd: root, encoding: "utf8" },
          )
        : "";
    const changed =
      fault === "sender"
        ? original.slice(0, original.indexOf("  async report(ctx:")) +
          unsafe.slice(unsafe.indexOf("  async report(ctx:"))
        : fault === "time"
          ? original.replace(
              /const observedAt = Math.min\([\s\S]*?\);/,
              "const observedAt = sample.observedAt;",
            )
          : fault === "ordering"
            ? original.replace(
                /requireThat\(\s*!previous[\s\S]*?"Older physical receipt cannot replace a newer observation",\s*\);/,
                "void previous;",
              )
            : original
                .replace(
                  /requireThat\(\s*Date.now\(\) - value.startedAt[\s\S]*?"Incomplete census expired; use a new sample ID",\s*\);/,
                  "// Old attempt accepted",
                )
                .replace(
                  /requireThat\(\s*sample.observedAt - attempt.startedAt[\s\S]*?"Census contains stale physical observations; use a new sample ID",\s*\);/,
                  "// Stale leaves accepted",
                );
    assert.notEqual(changed, original, `Fault did not apply: ${fault}`);
    await writeFile(path, changed);
    const compiled = await run([
      resolve(root, "node_modules/typescript/bin/tsc"),
      "-p",
      "apps/worker/tsconfig.json",
    ]);
    assert.equal(
      compiled.code,
      0,
      `Fault did not compile under unchanged Worker options: ${compiled.output}`,
    );
    const pattern = fault === "ordering" ? "lost child.*partial" : "aged incomplete";
    const tested = await run([
      "--test",
      `--test-name-pattern=${pattern}`,
      "apps/worker/test/workspace/sampler-freshness.test.ts",
    ]);
    assert.notEqual(tested.code, 0, `Sampler fault escaped behavioral oracle: ${fault}`);
    assert.match(
      tested.output,
      /AssertionError/,
      `Fault failed outside its oracle: ${tested.output}`,
    );
    console.log(`Strictly compiled sampler fault caught: ${fault}`);
  }
} finally {
  await writeFile(path, original);
  await unlink(backup);
}
