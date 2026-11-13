import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { repository, tests } from "../../build-workspaces.ts";

const gates = "scripts/test/release/gates.test.ts";
const provenance = "packages/fortipi-cli/test/enforcer-context-provenance.test.ts";
const roots = [
  "tests/clients",
  "packages/fortipi-client/test",
  "scripts/test/release",
  "packages/fortipi-cli/test",
];

async function fixture(fail?: "ordinary" | "gates") {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-test-schedule-"));
  const journal = join(directory, "observed.txt");
  const files = [
    "tests/clients/ordinary.test.ts",
    "tests/clients/gates.test.ts",
    `packages/fortipi-client/test/extra-${randomUUID()}.spec.ts`,
    gates,
    provenance,
  ];
  await writeFile(journal, "");
  for (const path of files) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    const cases = path === gates ? ["one", "two"] : ["one"];
    await writeFile(
      join(directory, path),
      `import test from 'node:test';import {appendFile} from 'node:fs/promises';\n${cases.map((name) => `test(${JSON.stringify(name)},async()=>{await appendFile(${JSON.stringify(journal)},${JSON.stringify(`${path}:${name}\n`)});${(fail === "ordinary" && path === files[0]) || (fail === "gates" && path === gates) ? "throw new Error('controlled child failure');" : ""}});`).join("\n")}\n`,
    );
  }
  await copyFile(
    resolve(repository, "scripts/source-test-processes.ts"),
    join(directory, "scripts/source-test-processes.ts"),
  );
  return {
    directory,
    files,
    journal,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

function runner(directory: string, advance = 2000) {
  let clock = 0,
    active = false;
  const calls: { files: string[]; timeout: number; began: number; args: string[] }[] = [];
  return {
    calls,
    now: () => clock,
    execute: async (command: string, args: string[], cwd?: string, timeout?: number) => {
      assert.equal(active, false, "A serial lane must await the previous child");
      assert.equal(cwd, directory);
      assert.ok(timeout !== undefined && timeout > 0);
      assert.ok(
        !args.some(
          (a) => a.startsWith("--test-concurrency") || a.startsWith("--test-name-pattern"),
        ),
      );
      assert.deepEqual(args.slice(0, 4), [
        "--require",
        join(directory, "scripts/source-test-processes.ts"),
        "--test",
        "--test-reporter=tap",
      ]);
      calls.push({ files: args.slice(4), timeout, began: clock, args });
      active = true;
      try {
        await promisify(execFile)(command, args, { cwd, env: {}, timeout, maxBuffer: 100_000 });
      } finally {
        active = false;
        clock += advance;
      }
    },
  };
}

test("discovered files run once: ordinary children, whole gates file, then provenance under one deadline", {
  timeout: 15000,
}, async () => {
  const f = await fixture();
  try {
    const r = runner(f.directory);
    // Overlapping roots cannot duplicate a selected file; the arbitrary spec is discovered normally.
    await tests([...roots, "tests/clients"], true, 10_000, {
      directory: f.directory,
      execute: r.execute,
      now: r.now,
    });
    assert.equal(r.calls.length, 3);
    const selected = r.calls.flatMap((c) => c.files);
    assert.equal(new Set(selected).size, selected.length);
    assert.deepEqual([...selected].sort(), f.files.map((p) => join(f.directory, p)).sort());
    assert.deepEqual(r.calls[1]?.files, [join(f.directory, gates)]);
    assert.deepEqual(r.calls[2]?.files, [join(f.directory, provenance)]);
    assert.ok(r.calls.every((c) => c.timeout + c.began === 10_000));
    assert.ok(r.calls.every((c, i) => i === 0 || c.timeout < (r.calls[i - 1]?.timeout ?? 0)));
    const entries = (await readFile(f.journal, "utf8")).trim().split("\n");
    assert.deepEqual(
      [...entries].sort(),
      f.files
        .flatMap((path) =>
          (path === gates ? ["one", "two"] : ["one"]).map((name) => `${path}:${name}`),
        )
        .sort(),
      "Every controlled test body, including both gates bodies, must actually execute once",
    );
    const ordinary = f.files.filter((p) => p !== gates && p !== provenance);
    for (const path of ordinary)
      assert.ok(entries.indexOf(`${path}:one`) < entries.indexOf(`${gates}:one`));
    assert.ok(entries.indexOf(`${gates}:one`) < entries.indexOf(`${gates}:two`));
    assert.ok(entries.indexOf(`${gates}:two`) < entries.indexOf(`${provenance}:one`));

    for (const root of ["tests/clients", "scripts/test/release", "packages/fortipi-cli/test"]) {
      await writeFile(f.journal, "");
      const subset = runner(f.directory);
      await tests([root], true, 10_000, {
        directory: f.directory,
        execute: subset.execute,
        now: subset.now,
      });
      assert.equal(subset.calls.length, 1);
      const call = subset.calls[0];
      assert.ok(call);
      assert.deepEqual(
        [...call.files].sort(),
        f.files
          .filter((p) => p.startsWith(`${root}/`))
          .map((p) => join(f.directory, p))
          .sort(),
      );
    }
  } finally {
    await f.close();
  }
});

test("ordinary or gates child failure blocks every later lane", { timeout: 15000 }, async () => {
  for (const failure of ["ordinary", "gates"] as const) {
    const f = await fixture(failure);
    try {
      const r = runner(f.directory);
      await assert.rejects(
        tests(roots, true, 10_000, { directory: f.directory, execute: r.execute, now: r.now }),
      );
      assert.equal(r.calls.length, failure === "ordinary" ? 1 : 2);
      assert.ok(!r.calls.flatMap((c) => c.files).includes(join(f.directory, provenance)));
      const entries = await readFile(f.journal, "utf8");
      assert.ok(!entries.includes(`${provenance}:`));
      if (failure === "ordinary") assert.ok(!entries.includes(`${gates}:`));
    } finally {
      await f.close();
    }
  }
});

test("exhausted shared time and missing or empty roots cannot start a later child", {
  timeout: 15000,
}, async () => {
  const f = await fixture();
  try {
    const r = runner(f.directory, 10_001);
    await assert.rejects(
      tests(roots, true, 10_000, { directory: f.directory, execute: r.execute, now: r.now }),
      /Full source test deadline exhausted/,
    );
    assert.equal(r.calls.length, 1);
    assert.ok(!(await readFile(f.journal, "utf8")).includes(`${gates}:`));
    await mkdir(join(f.directory, "empty"));
    for (const root of ["empty", "missing"]) {
      const unused = runner(f.directory);
      await assert.rejects(
        tests([root], true, 10_000, {
          directory: f.directory,
          execute: unused.execute,
          now: unused.now,
        }),
      );
      assert.deepEqual(unused.calls, []);
    }
  } finally {
    await f.close();
  }
});
