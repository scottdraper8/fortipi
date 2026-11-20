import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "@babel/parser";
import { recoveryInspectionRecord } from "../../../apps/worker/test/agent/recovery-inspection-observation.ts";
import {
  instrumentPiOpenSource,
  piOpenPhases,
} from "../../../apps/worker/test/integration/pi-open-observation.ts";

const repository = resolve(import.meta.dirname, "../../..");
const require = createRequire(resolve(repository, "apps/worker/package.json"));
const observer = "__fortipiPiOpenObservation";
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized).filter((x) => x !== undefined);
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  if (node.type === "FunctionDeclaration" && (node.id as { name?: string })?.name === observer)
    return undefined;
  if (node.type === "ExpressionStatement") {
    const expression = node.expression as { type?: string; callee?: { name?: string } };
    if (expression.type === "CallExpression" && expression.callee?.name === observer)
      return undefined;
  }
  return Object.fromEntries(
    Object.entries(node)
      .filter(
        ([key]) =>
          ![
            "start",
            "end",
            "loc",
            "extra",
            "comments",
            "leadingComments",
            "trailingComments",
            "innerComments",
            "tokens",
          ].includes(key),
      )
      .map(([key, entry]) => [key, normalized(entry)]),
  );
}
const ast = (source: string) => parse(source, { sourceType: "module", plugins: ["typescript"] });

test("Pi-open diagnostic inserts only closed observations around original source statements", async () => {
  for (const [kind, path, count] of [
    ["sdk", require.resolve("agents/harness/pi"), 8],
    ["factory", resolve(repository, "apps/worker/src/agent/agent-session.ts"), 3],
  ] as const) {
    const source = await readFile(path, "utf8");
    const result = instrumentPiOpenSource(source, kind);
    assert.equal(result.sites.length, count);
    assert.equal(new Set(result.sites.map((site) => site.phase)).size, count);
    assert.deepEqual(normalized(ast(result.contents)), normalized(ast(source)));
    assert.throws(() => instrumentPiOpenSource(`${source}\n`, kind), assert.AssertionError);
  }
});

test("injected Pi-open emitter publishes only canonical fixed worker facts", async () => {
  const source = await readFile(require.resolve("agents/harness/pi"), "utf8");
  const result = instrumentPiOpenSource(source, "sdk");
  const declaration = ast(result.contents).program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === observer,
  );
  assert.ok(declaration?.start !== undefined && declaration?.end !== undefined);
  const output: string[] = [];
  const emit = runInNewContext(
    `${result.contents.slice(declaration.start ?? 0, declaration.end ?? 0)}\n${observer}`,
    { console: { log: (line: string) => output.push(line) } },
  ) as (phase: unknown, event: unknown) => void;
  for (const phase of piOpenPhases) for (const event of ["enter", "exit"]) emit(phase, event);
  assert.equal(output.length, piOpenPhases.length * 2);
  for (const line of output) {
    assert.equal(recoveryInspectionRecord(line), line);
    assert.ok(Buffer.byteLength(`${line}\n`) <= 128);
  }
  const canary = "private-payload-credential-path-canary";
  let accesses = 0;
  const hostile = {
    toJSON() {
      accesses++;
      throw Error(canary);
    },
    toString() {
      accesses++;
      return canary;
    },
  };
  const before = output.length;
  for (const value of [canary, hostile, {}, null, 1, Symbol(canary)]) {
    emit(value, "enter");
    emit("pi-ready", value);
  }
  assert.equal(output.length, before);
  assert.equal(accesses, 0);
  assert.equal(output.join("\n").includes(canary), false);
  const broken = runInNewContext(
    `${result.contents.slice(declaration.start ?? 0, declaration.end ?? 0)}\n${observer}`,
    {
      console: {
        log() {
          throw Error(canary);
        },
      },
    },
  ) as (phase: unknown, event: unknown) => void;
  assert.doesNotThrow(() => broken("pi-ready", "enter"));
  const inverseOutput: string[] = [];
  const weakened = result.contents
    .slice(declaration.start ?? 0, declaration.end ?? 0)
    .replace(".includes(phase)", '.includes("pi-ready")');
  const unsafeEmit = runInNewContext(`${weakened}\n${observer}`, {
    console: { log: (line: string) => inverseOutput.push(line) },
  }) as (phase: unknown, event: unknown) => void;
  unsafeEmit(canary, "enter");
  assert.throws(
    () => assert.equal(inverseOutput.join("\n").includes(canary), false),
    assert.AssertionError,
  );
});
