import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { basename, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "@babel/parser";
import {
  observeRecoveryInspection,
  recoveryInspectionRecord,
} from "../../../apps/worker/test/agent/recovery-inspection-observation.ts";
import {
  instrumentPiOpenSource,
  observationRecordLimit,
  piOpenObservationSources,
  piOpenPhases,
} from "../../../apps/worker/test/integration/pi-open-observation.ts";

const repository = resolve(import.meta.dirname, "../../..");
const sources = piOpenObservationSources(repository);
const observer = "__fortipiPiOpenObservation";
const counter = `${observer}Count`;
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized).filter((x) => x !== undefined);
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  if (
    node.type === "VariableDeclaration" &&
    (node.declarations as { id?: { name?: string } }[])[0]?.id?.name === counter
  )
    return undefined;
  if (
    node.type === "SequenceExpression" &&
    (node.expressions as { callee?: { name?: string } }[]).some(
      (expression) => expression.callee?.name === observer,
    )
  ) {
    const expressions = normalized(node.expressions) as unknown[];
    assert.equal(expressions.length, 1);
    return expressions[0];
  }
  if (node.type === "CallExpression" && (node.callee as { name?: string })?.name === observer)
    return undefined;
  if (node.type === "IfStatement") {
    const consequent = node.consequent as { expression?: { callee?: { name?: string } } };
    if (consequent.expression?.callee?.name === observer) return undefined;
  }
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

test("diagnostic compiler preserves all original AST and awaits for every pinned source", async () => {
  for (const [kind, path, count] of [
    ["sdk", sources.sdk, 8],
    ["factory", sources.factory, 9],
    ["recovery", sources.recovery, 1],
    ["chord", sources.chord, 3],
    ["piStorage", sources.piStorage, 2],
    ["router", sources.router, 1],
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
  const source = await readFile(sources.sdk, "utf8");
  const result = instrumentPiOpenSource(source, "sdk");
  const declaration = ast(result.contents).program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === observer,
  );
  assert.ok(declaration?.start !== undefined && declaration?.end !== undefined);
  const output: string[] = [];
  const emitterSource = `let ${counter} = 0;\n${result.contents.slice(declaration.start ?? 0, declaration.end ?? 0)}`;
  const emit = runInNewContext(`${emitterSource}\n${observer}`, {
    console: { log: (line: string) => output.push(line) },
  }) as (phase: unknown, event: unknown) => void;
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
  const broken = runInNewContext(`${emitterSource}\n${observer}`, {
    console: {
      log() {
        throw Error(canary);
      },
    },
  }) as (phase: unknown, event: unknown) => void;
  assert.doesNotThrow(() => broken("pi-ready", "enter"));
  const inverseOutput: string[] = [];
  const weakened = emitterSource.replace(".includes(phase)", '.includes("pi-ready")');
  const unsafeEmit = runInNewContext(`${weakened}\n${observer}`, {
    console: { log: (line: string) => inverseOutput.push(line) },
  }) as (phase: unknown, event: unknown) => void;
  unsafeEmit(canary, "enter");
  assert.throws(
    () => assert.equal(inverseOutput.join("\n").includes(canary), false),
    assert.AssertionError,
  );
  const capped: string[] = [];
  const bounded = runInNewContext(`${emitterSource}\n${observer}`, {
    console: { log: (line: string) => capped.push(line) },
  }) as (phase: unknown, event: unknown) => void;
  for (let i = 0; i < observationRecordLimit + 50; i++) bounded("chord-queue-operation", "enter");
  assert.equal(capped.length, observationRecordLimit + 1);
  assert.equal(JSON.parse(capped.at(-1)!).phase, "storage-observation-limit");
  for (const line of capped) assert.equal(recoveryInspectionRecord(line), line);
});

test("Chord markers preserve original queue/storage promises, receivers and callback rejection", async () => {
  const source = await readFile(sources.chord, "utf8");
  const observed = instrumentPiOpenSource(source, "chord").contents;
  const records: string[] = [];
  const Database = runInNewContext(
    `${observed.replace("export class", "class")}\nDurableObjectSqliteDatabase`,
    { console: { log: (line: string) => records.push(line) } },
  );
  const queuePromise = Promise.resolve(Object.freeze({ queue: true }));
  const storagePromise = Promise.resolve(Object.freeze({ storage: true }));
  let operation: (() => unknown) | undefined, callback: (() => Promise<unknown>) | undefined;
  const storage = {
    transaction(fn: () => Promise<unknown>) {
      assert.equal(this, storage);
      callback = fn;
      return storagePromise;
    },
  };
  const db = new Database(storage);
  db.queue.hold = (fn: () => unknown) => {
    operation = fn;
    return queuePromise;
  };
  const result = Object.freeze({ value: true }),
    failure = Object.freeze({ failure: true });
  let transaction: { active: boolean } | undefined;
  assert.equal(
    db.transaction((tx: { active: boolean }) => {
      transaction = tx;
      return result;
    }),
    queuePromise,
  );
  assert.ok(operation);
  assert.equal(operation(), storagePromise);
  assert.ok(callback);
  assert.equal(await callback(), result);
  assert.equal(transaction?.active, false);
  assert.deepEqual(
    records.map((r) => [JSON.parse(r).phase, JSON.parse(r).event]),
    [
      ["chord-transaction-request", "enter"],
      ["chord-queue-operation", "enter"],
      ["chord-storage-callback", "enter"],
      ["chord-storage-callback", "exit"],
    ],
  );
  db.transaction(() => {
    throw failure;
  });
  operation();
  let rejected: unknown;
  try {
    await callback();
  } catch (error) {
    rejected = error;
  }
  assert.equal(rejected, failure);
  assert.equal(JSON.parse(records.at(-1)!).phase, "chord-storage-callback");
  assert.equal(JSON.parse(records.at(-1)!).event, "exit");
});

test("Node STATE markers preserve original fetch/body awaits and isolate the first-kind path", async () => {
  const path = resolve(repository, "apps/worker/test/integration/runtime.ts");
  const source = await readFile(path, "utf8"),
    tree = ast(source);
  let api: { start?: number | null; end?: number | null } | undefined;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as { type?: string; id?: { name?: string }; init?: unknown };
    if (node.type === "VariableDeclarator" && node.id?.name === "api")
      api = node.init as typeof api;
    for (const [key, child] of Object.entries(value))
      if (!["loc", "comments", "tokens"].includes(key)) visit(child);
  };
  visit(tree);
  assert.ok(api?.start !== undefined && api.end !== undefined);
  const code = stripTypeScriptTypes(
    `const api = ${source.slice(api.start ?? 0, api.end ?? 0)};\napi`,
  );
  const records: string[] = [],
    body = Promise.withResolvers<unknown>(),
    headers = Promise.withResolvers<unknown>(),
    bodyEntered = Promise.withResolvers<void>();
  const options = { main: "/controlled/admission-identity-baseline.js" };
  let fetchCalls = 0,
    bodyCalls = 0;
  const call = runInNewContext(code, {
    assert,
    basename,
    options,
    endpoint: "https://controlled.invalid",
    admin: "synthetic-not-auth",
    AbortSignal,
    console: { error: (line: string) => records.push(line) },
    observeRecoveryInspection,
    fetch: () => {
      fetchCalls++;
      return headers.promise;
    },
  }) as (path: string) => Promise<unknown>;
  const pending = call("/__test/agents/agent/state");
  assert.equal(JSON.parse(records.at(-1)!).phase, "api-state-fetch-enter");
  headers.resolve({
    status: 200,
    json: () => {
      bodyCalls++;
      bodyEntered.resolve();
      return body.promise;
    },
  });
  await bodyEntered.promise;
  assert.equal(JSON.parse(records.at(-1)!).phase, "api-state-headers");
  const value = Object.freeze({ componentOnly: true });
  body.resolve(value);
  const response = (await pending) as { status: number; body: unknown };
  assert.equal(response.body, value);
  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 1);
  assert.equal(bodyCalls, 1);
  for (const record of records) assert.equal(recoveryInspectionRecord(record), record);
  records.length = 0;
  options.main = "/controlled/another-fixture.js";
  await call("/__test/agents/agent/state");
  assert.equal(records.length, 0);
  options.main = "/controlled/admission-identity-mutant.js";
  await call("/__test/agents/agent/state?private=value");
  assert.equal(records.length, 0);
});
