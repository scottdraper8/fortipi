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
test("renewal identity and private child disclosure regressions fail their consumer oracles", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "fortipi-enforcer-regression-"));
  try {
    const target = resolve(temp, "packages/fortipi-contract");
    await mkdir(target, { recursive: true });
    for (const dir of ["schemas", "test", "dist"])
      await cp(resolve(packageRoot, dir), resolve(target, dir), { recursive: true });
    await symlink(resolve(repo, "node_modules"), resolve(temp, "node_modules"), "dir");
    await writeFile(resolve(temp, "package.json"), '{"type":"module"}\n');
    const cases = [
      {
        label: "ordered directory recreation",
        path: "dist/compatibility.js",
        test: "compatibility",
        pattern: "local stage directory recreation",
        failure: /unwanted rejection|put_metadata/,
        mutate: (source: string): string => {
          const reset = 'if (mutation.kind !== "mkdir")\n            replaced.add(mutation.path);';
          assert.ok(source.includes(reset), "Missing emitted descendant reset");
          return source.replace(
            reset,
            'if (!superseded && mutation.kind !== "mkdir")\n            replaced.add(mutation.path);',
          );
        },
      },
      {
        label: "local intent renewal exclusion",
        path: "dist/compatibility.js",
        test: "compatibility",
        pattern: "local intent and final commit",
        failure: /AssertionError|strictEqual/,
        mutate: (source: string): string => {
          const projected = "lease: leaseIdentity";
          assert.ok(source.includes(projected));
          return source.replace(projected, "lease: scope.lease");
        },
      },
      {
        label: "one-time credential redaction",
        path: "schemas/administration.schema.json",
        test: "schema",
        pattern: "credential issuance returns",
        failure: /CredentialReceipt/,
        mutate: (source: string): string => {
          const schema = JSON.parse(source);
          schema.$defs.CredentialReceipt.oneOf[1].properties.token = { type: "string" };
          return JSON.stringify(schema);
        },
      },
      {
        label: "local-stage digest guard",
        path: "dist/compatibility.js",
        test: "compatibility",
        pattern: "local stages carry explicit",
        failure: /Missing expected rejection/,
        mutate: (source: string): string => {
          const guard = "if (input.stagedDigest !== expectedStage)";
          assert.ok(source.includes(guard), "Missing emitted local-stage digest guard");
          return source.replace(guard, "if (false)");
        },
      },
      ...["Operation", "Assignment"].map((digest) => ({
        label: `${digest.toLowerCase()} digest guard`,
        path: "dist/compatibility.js",
        test: "compatibility",
        pattern: "received assignments reconstruct",
        failure: /Missing expected rejection/,
        mutate: (source: string): string => {
          const guard = `if (identity.${digest.toLowerCase()}Digest !== expected${digest})`;
          assert.ok(source.includes(guard), `Missing emitted ${digest} guard`);
          return source.replace(guard, "if (false)");
        },
      })),
      {
        label: "renewal field projection",
        path: "dist/compatibility.js",
        test: "compatibility",
        pattern: "commit identity survives",
        failure: /AssertionError|strictEqual/,
        mutate: (source: string): string => {
          const start = source.indexOf("leaseIdentity: {");
          const end = source.indexOf("storage: input.storage", start);
          assert.ok(start > 0 && end > start);
          return `${source.slice(0, start)}leaseIdentity: input.leaseIdentity,\n${source.slice(end)}`;
        },
      },
      {
        label: "private seal disclosure",
        path: "schemas/workspaces.schema.json",
        test: "schema",
        pattern: "public commits use only",
        failure: /CommitReceipt/,
        mutate: (source: string): string => {
          const schema = JSON.parse(source);
          schema.$defs.CommitReceipt.oneOf[0].properties.storeRef = {
            $ref: `${schema.$id}#/$defs/SealedStore`,
          };
          return JSON.stringify(schema);
        },
      },
    ];
    for (const challenge of cases) {
      const args = [
        "--test",
        `--test-name-pattern=${challenge.pattern}`,
        `packages/fortipi-contract/test/${challenge.test}.test.ts`,
      ];
      const baseline = run(temp, ...args);
      assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
      const path = resolve(target, challenge.path),
        original = await readFile(path, "utf8");
      await writeFile(path, challenge.mutate(original));
      const mutant = run(temp, ...args);
      assert.notEqual(mutant.status, 0, `Undetected mutation: ${challenge.path}`);
      assert.match(mutant.stdout + mutant.stderr, challenge.failure);
      console.log(`Sensitivity observed: ${challenge.label} -> ${challenge.pattern} failed`);
      await writeFile(path, original);
      const restored = run(temp, ...args);
      assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
