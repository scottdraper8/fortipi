import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";
import { parse } from "@babel/parser";
import { type Node, VISITOR_KEYS } from "@babel/types";
import type { StartObservation } from "./start-ledger-child.ts";

const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const source = "packages/fortipi-executor/src/ledger.ts";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const execute = promisify(execFile);

export interface StartLedgerSensitivity {
  id: "start-ledger-dedup";
  outcome: "killed" | "survived" | "unavailable";
  source?: string;
  sourceSha256?: string;
  patchSha256?: string;
  baseline?: StartObservation;
  mutant?: StartObservation;
  restored?: StartObservation;
  limitation?: string;
}

function site(text: string) {
  const ast = parse(text, { sourceType: "module", plugins: ["typescript"] });
  const ledger = ast.program.body
    .map((node) => (node.type === "ExportNamedDeclaration" ? node.declaration : node))
    .find((node) => node?.type === "ClassDeclaration" && node.id?.name === "Ledger");
  assert.ok(ledger?.type === "ClassDeclaration");
  const admit = ledger.body.body.find(
    (node) =>
      node.type === "ClassMethod" && node.key.type === "Identifier" && node.key.name === "admit",
  );
  assert.ok(admit?.type === "ClassMethod", "Ledger.admit AST site missing");
  const matches: { start: number; end: number }[] = [];
  const visit = (node: Node, previous = false) => {
    const inside =
      previous ||
      (node.type === "IfStatement" &&
        node.test.type === "Identifier" &&
        node.test.name === "previous");
    if (
      inside &&
      node.type === "ReturnStatement" &&
      node.argument?.type === "Identifier" &&
      node.argument.name === "previous"
    ) {
      assert.ok(typeof node.start === "number" && typeof node.end === "number");
      matches.push({ start: node.start, end: node.end });
    }
    const record = node as unknown as Record<string, unknown>;
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const value = record[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child) visit(child as Node, inside);
      } else if (value && typeof value === "object") visit(value as Node, inside);
    }
  };
  visit(admit.body);
  assert.equal(matches.length, 1, "Ledger.admit return-previous site must be unique");
  const node = matches[0];
  assert.ok(node);
  return node;
}

function environment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG"].flatMap(
      (key) => (process.env[key] ? [[key, process.env[key]]] : []),
    ),
  );
}

/** Disposable source builds only; this never mutates the checkout or needs a candidate. */
export async function runStartLedgerSensitivity(): Promise<StartLedgerSensitivity> {
  const result: StartLedgerSensitivity = {
    id: "start-ledger-dedup",
    outcome: "unavailable",
    source,
  };
  const original = await readFile(join(root, source), "utf8");
  result.sourceSha256 = hash(original);
  const temporary = await mkdtemp(join(await realpath(tmpdir()), "fortipi-start-ledger-"));
  const executor = join(temporary, "packages/fortipi-executor");
  const ledger = join(temporary, source);
  const child = fileURLToPath(new URL("./start-ledger-child.ts", import.meta.url));
  const nonce = randomUUID();
  const compile = (project: string) =>
    execute(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "-p",
        join(temporary, project, "tsconfig.json"),
      ],
      { env: environment(), timeout: 60000, maxBuffer: 1000000 },
    );
  const probe = async (phase: string): Promise<StartObservation> => {
    const coverage = join(temporary, `coverage-${phase}`);
    const compiled = join(executor, "dist/ledger.js");
    const code = await readFile(compiled, "utf8");
    const target = site(code);
    const output = await execute(process.execPath, [child, "scenario", executor, nonce], {
      env: { ...environment(), NODE_V8_COVERAGE: coverage },
      timeout: 20000,
      maxBuffer: 1000000,
    });
    const observed = JSON.parse(output.stdout) as StartObservation;
    const ranges: { startOffset: number; endOffset: number; count: number }[] = [];
    for (const file of await readdir(coverage)) {
      const data = JSON.parse(await readFile(join(coverage, file), "utf8")) as {
        result: { url: string; functions: { isBlockCoverage: boolean; ranges: typeof ranges }[] }[];
      };
      for (const script of data.result)
        if (script.url === pathToFileURL(compiled).href)
          for (const fn of script.functions)
            if (fn.isBlockCoverage)
              ranges.push(
                ...fn.ranges.filter(
                  (range) => range.startOffset <= target.start && range.endOffset >= target.end,
                ),
              );
    }
    ranges.sort((a, b) => a.endOffset - a.startOffset - (b.endOffset - b.startOffset));
    assert.ok(ranges[0] && ranges[0].count > 0, "dedup return site was not executed");
    observed.siteCount = ranges[0].count;
    observed.compiledSha256 = hash(code);
    assert.equal(observed.scenarioSha256, hash(await readFile(child)));
    return observed;
  };
  try {
    assert.equal(process.versions.node, "26.13.1");
    const inputs = await execute(
      "git",
      [
        "status",
        "--porcelain",
        "--",
        "packages/fortipi-contract",
        "packages/fortipi-executor",
        "package.json",
        "tsconfig.json",
      ],
      { cwd: root, env: environment() },
    );
    assert.equal(inputs.stdout, "", "source sensitivity inputs must be clean");
    for (const path of ["package.json", "tsconfig.json"])
      await cp(join(root, path), join(temporary, path));
    await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "junction");
    for (const name of ["contract", "executor"]) {
      const project = `packages/fortipi-${name}`;
      await mkdir(join(temporary, project), { recursive: true });
      for (const path of ["package.json", "tsconfig.json", "src"])
        await cp(join(root, project, path), join(temporary, project, path), { recursive: true });
    }
    await symlink(
      join(root, "packages/fortipi-contract/node_modules"),
      join(temporary, "packages/fortipi-contract/node_modules"),
      "junction",
    );
    await mkdir(join(executor, "node_modules"));
    await symlink(
      join(temporary, "packages/fortipi-contract"),
      join(executor, "node_modules/fortipi-contract"),
      "junction",
    );
    await symlink(
      await realpath(join(root, "packages/fortipi-executor/node_modules/ajv")),
      join(executor, "node_modules/ajv"),
      "junction",
    );
    await cp(
      join(root, "packages/fortipi-executor/test/fixtures"),
      join(executor, "test/fixtures"),
      { recursive: true },
    );
    await compile("packages/fortipi-contract");
    await compile("packages/fortipi-executor");
    result.baseline = await probe("baseline");
    assert.deepEqual(result.baseline.records, [nonce], "baseline external start oracle failed");
    const target = site(original);
    const replacement =
      "{ previous.state = 'pending'; previous.incarnation = this.incarnation; delete previous.result; this.put(previous); return previous; }";
    result.patchSha256 = hash(
      JSON.stringify({
        ...target,
        before: original.slice(target.start, target.end),
        after: replacement,
      }),
    );
    try {
      await writeFile(
        ledger,
        original.slice(0, target.start) + replacement + original.slice(target.end),
      );
      await compile("packages/fortipi-executor");
      result.mutant = await probe("mutant");
    } finally {
      await writeFile(ledger, original);
      await compile("packages/fortipi-executor");
      result.restored = await probe("restored");
      assert.deepEqual(result.restored.records, [nonce], "restored external start oracle failed");
      assert.equal(result.restored.compiledSha256, result.baseline.compiledSha256);
    }
    assert.notEqual(result.mutant.compiledSha256, result.baseline.compiledSha256);
    if (
      result.mutant.records.length === 2 &&
      result.mutant.records.every((record) => record === nonce)
    )
      result.outcome = "killed";
    else if (result.mutant.repeatError)
      result.limitation = `Single-site rearm reached but another runtime fence rejected: ${result.mutant.repeatError}`;
    else {
      result.outcome = "survived";
      result.limitation =
        "Executed rearm did not produce two external starts; this sensitivity is not qualified.";
    }
  } catch (error) {
    result.outcome = "unavailable";
    const reason =
      error instanceof Error && "cmd" in error
        ? "child/build subprocess failed or timed out"
        : error instanceof Error
          ? error.message
          : "unknown failure";
    result.limitation =
      `Sensitivity unavailable; no compile/error/timeout counts as killed: ${reason}`.slice(0, 700);
  } finally {
    assert.equal(
      hash(await readFile(join(root, source))),
      result.sourceSha256,
      "checkout source changed during sensitivity",
    );
    await rm(temporary, { recursive: true, force: true });
  }
  return result;
}

if (import.meta.main) {
  const result = await runStartLedgerSensitivity();
  console.log(JSON.stringify(result));
  if (result.outcome !== "killed") process.exitCode = 1;
}
