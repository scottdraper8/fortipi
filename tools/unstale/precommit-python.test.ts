import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { precommitLock, provisionPrecommit, sha256, verifyPrecommit } from "./precommit-python.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const parent = resolve(repository, "dist/precommit-tests");
const canonical = process.env.FORTIPI_PRECOMMIT_TEST_PYTHON;
assert.ok(canonical, "Set explicit FORTIPI_PRECOMMIT_TEST_PYTHON to the pinned interpreter");
let coldArchiveRoot: string | undefined;

function command(tool: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((accept, reject) => {
    const child = execFile(
      tool,
      args,
      { cwd, env, timeout: 180000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number")
          reject(new Error("Cold hook operation unavailable"));
        else accept({ code: error ? Number(error.code) : 0, output: stdout + stderr });
      },
    );
    child.stdin?.end();
  });
}
async function contents(path: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(path)) {
    const entry = resolve(path, name);
    found.push(entry);
    if ((await lstat(entry)).isDirectory()) found.push(...(await contents(entry)));
  }
  return found;
}

test("cold pinned environment runs unchanged Python hook contracts and rejects canaries without a hook installer", {
  timeout: 300000,
}, async () => {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "cold-"));
  const directory = resolve(root, "tools");
  const originalHome = process.env.HOME;
  const bin = await provisionPrecommit(canonical, directory);
  coldArchiveRoot = resolve(directory, "archives");
  assert.equal(process.env.HOME, originalHome);
  const config = parse(await readFile(resolve(repository, ".pre-commit-config.yaml"), "utf8")) as {
    repos: { repo: string; hooks: { language: string }[] }[];
  };
  const sourceRepo = config.repos.find(
    (entry) => entry.repo === "https://github.com/pre-commit/pre-commit-hooks",
  );
  assert.ok(sourceRepo?.hooks.every((hook) => hook.language === "system"));
  await writeFile(resolve(root, "hooks.yaml"), stringify({ repos: [sourceRepo] }));
  await writeFile(resolve(root, "empty-gitconfig"), "");
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin:/usr/sbin:/sbin"}`,
    ...(process.platform === "win32" ? { SystemRoot: "C:\\Windows" } : {}),
    ...(originalHome ? { HOME: originalHome } : {}),
    PRE_COMMIT_HOME: resolve(directory, "pre-commit-home"),
    PYTHONDONTWRITEBYTECODE: "1",
    LANG: "C.UTF-8",
    GIT_CONFIG_GLOBAL: resolve(root, "empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = process.platform === "win32" ? "git.exe" : "/usr/bin/git";
  assert.equal((await command(git, ["init", "--quiet"], root, env)).code, 0);
  for (const [name, text] of Object.entries({
    "ordinary.yaml": "key: value\n",
    "pnpm-lock.yaml": "first: one\n---\nsecond: two\n",
    "ordinary.json": '{"key":"value"}\n',
    "small.txt": "small\n",
  }))
    await writeFile(resolve(root, name), text);
  const files = ["ordinary.yaml", "pnpm-lock.yaml", "ordinary.json", "small.txt"];
  assert.equal((await command(git, ["add", "--", ...files], root, env)).code, 0);
  const precommit = resolve(bin, process.platform === "win32" ? "pre-commit.exe" : "pre-commit");
  const run = () =>
    command(precommit, ["run", "--all-files", "--config", resolve(root, "hooks.yaml")], root, env);
  const positive = await run();
  assert.equal(positive.code, 0, positive.output);
  assert.ok(!/Installing environment for/.test(positive.output));
  for (const [file, bad, expected, restored] of [
    ["ordinary.yaml", "first: one\n---\nsecond: two\n", /Check Yaml.*Failed/is, "key: value\n"],
    ["ordinary.yaml", "broken: [\n", /Check Yaml.*Failed/is, "key: value\n"],
    ["ordinary.json", '{"broken":}\n', /Check JSON.*Failed/is, '{"key":"value"}\n'],
    ["small.txt", "x".repeat(501 * 1024), /Check for added large files.*Failed/is, "small\n"],
    [
      "small.txt",
      `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\nsynthetic-canary-only\n`,
      /Detect Private Key.*Failed/is,
      "small\n",
    ],
  ] as const) {
    await writeFile(resolve(root, file), bad);
    assert.equal((await command(git, ["add", "--", file], root, env)).code, 0);
    const result = await run();
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, expected);
    await writeFile(resolve(root, file), restored);
    assert.equal((await command(git, ["add", "--", file], root, env)).code, 0);
  }
  assert.equal((await run()).code, 0);
  const cache = await contents(resolve(directory, "pre-commit-home"));
  assert.ok(
    !cache.some((path) => /(?:py_env|python_env)/.test(path)),
    "Unexpected Python hook environment",
  );
  assert.deepEqual(
    await readdir(resolve(directory, "cache")),
    [],
    "Unexpected pip cache/resolver output",
  );
  assert.equal(await verifyPrecommit(directory, canonical), bin);
  console.log(
    JSON.stringify({
      proof: "cold-hooks",
      root,
      lockSha256: sha256(JSON.stringify(await precommitLock())),
      hookInstaller: false,
      canaries: 5,
      homeUnchanged: true,
    }),
  );
});

test("missing build artifact and altered runtime archive fail before interpreter or hooks can execute", async () => {
  await mkdir(parent, { recursive: true });
  const archiveRoot = coldArchiveRoot;
  assert.ok(archiveRoot, "This run's cold prerequisite must succeed first");
  const root = await mkdtemp(resolve(parent, "refused-"));
  const archives = resolve(root, "archives");
  await mkdir(archives);
  const lock = await precommitLock();
  for (const entry of [...lock.packages, ...lock.supportArchives])
    await copyFile(
      resolve(archiveRoot, entry.filename),
      resolve(archives, entry.filename),
      constants.COPYFILE_EXCL,
    );
  const cython = lock.packages.find((entry) => entry.name === "Cython");
  assert.ok(cython);
  await rm(resolve(archives, cython.filename));
  await assert.rejects(
    provisionPrecommit(resolve(root, "nonexistent-python"), resolve(root, "missing"), archives),
    /archive closure/,
  );
  await assert.rejects(access(resolve(root, "missing")));
  await copyFile(
    resolve(archiveRoot, cython.filename),
    resolve(archives, cython.filename),
    constants.COPYFILE_EXCL,
  );
  const dependency = lock.packages.find((entry) => entry.name === "cfgv");
  assert.ok(dependency);
  const bytes = await readFile(resolve(archives, dependency.filename));
  bytes[20] = (bytes[20] ?? 0) ^ 1;
  await chmod(resolve(archives, dependency.filename), 0o600);
  await writeFile(resolve(archives, dependency.filename), bytes);
  await assert.rejects(
    provisionPrecommit(resolve(root, "nonexistent-python"), resolve(root, "changed"), archives),
    /archive hash/,
  );
  await assert.rejects(access(resolve(root, "changed")));
});
