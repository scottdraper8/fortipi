import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(packageRoot, "../..");
function run(cwd: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120000,
  });
}
test("deterministic generation checks without rewriting and detects declaration/spec drift", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "fortipi-generation-"));
  try {
    const target = resolve(temp, "packages/fortipi-contract");
    await mkdir(target, { recursive: true });
    for (const dir of ["schemas", "src", "scripts"])
      await cp(resolve(packageRoot, dir), resolve(target, dir), { recursive: true });
    await cp(resolve(packageRoot, "openapi.yaml"), resolve(target, "openapi.yaml"));
    await symlink(resolve(repo, "node_modules"), resolve(temp, "node_modules"), "dir");
    await writeFile(resolve(temp, "package.json"), '{"type":"module"}\n');
    let result = run(temp, "packages/fortipi-contract/scripts/generate.ts", "--check");
    assert.equal(result.status, 0, result.stderr);
    for (const file of ["src/generated/types.ts", "openapi.yaml"]) {
      const path = resolve(target, file),
        original = await readFile(path, "utf8");
      await writeFile(path, `${original}\n`);
      result = run(temp, "packages/fortipi-contract/scripts/generate.ts", "--check");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Generated drift/);
      assert.equal(await readFile(path, "utf8"), `${original}\n`);
      await writeFile(path, original);
    }
    result = run(temp, "packages/fortipi-contract/scripts/generate.ts");
    assert.equal(result.status, 0, result.stderr);
    result = run(temp, "packages/fortipi-contract/scripts/generate.ts", "--check");
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test("reversible known-type exclusion mutation is caught by malformed-known oracle", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "fortipi-known-event-"));
  try {
    const target = resolve(temp, "packages/fortipi-contract");
    await mkdir(target, { recursive: true });
    for (const dir of ["schemas", "test", "dist"])
      await cp(resolve(packageRoot, dir), resolve(target, dir), { recursive: true });
    await symlink(resolve(repo, "node_modules"), resolve(temp, "node_modules"), "dir");
    await writeFile(resolve(temp, "package.json"), '{"type":"module"}\n');
    const args = [
      "--test",
      "--test-name-pattern=malformed known event",
      "packages/fortipi-contract/test/compatibility.test.ts",
    ];
    const baseline = run(temp, ...args);
    assert.equal(baseline.status, 0, baseline.stderr + baseline.stdout);
    const path = resolve(target, "schemas/client-events.schema.json");
    const schema = JSON.parse(await readFile(path, "utf8"));
    for (const name of ["UnknownDurableEvent", "UnknownVolatileEvent"])
      delete schema.$defs[name].properties.type.not;
    await writeFile(path, JSON.stringify(schema));
    const mutant = run(temp, ...args);
    assert.notEqual(mutant.status, 0);
    assert.match(mutant.stdout + mutant.stderr, /malformed-known exclusion/);
    await cp(resolve(packageRoot, "schemas/client-events.schema.json"), path);
    const restored = run(temp, ...args);
    assert.equal(restored.status, 0, restored.stderr + restored.stdout);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
