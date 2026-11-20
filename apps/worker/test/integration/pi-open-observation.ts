// Diagnostic compilation only; never modify installed SDK or production source bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parse } from "@babel/parser";
import type { Plugin } from "esbuild";

export const piOpenPhases = [
  "pi-ready",
  "pi-last-close",
  "pi-session-store",
  "pi-harness-factory",
  "pi-root",
  "pi-resume",
  "pi-open-timer",
  "pi-open-wake",
  "pi-factory-store",
  "pi-factory-models",
  "pi-factory-harness",
] as const;
const observer = "__fortipiPiOpenObservation";
const hashes = {
  sdk: "260e3af51748cb7eade4a6a1546f23d0bf515fda155b5e8029845e82bb85d5e7",
  factory: "2f235cdc46174819060aaa1c3800ad0448d770dc5126a748216ce70077c798f9",
};
type Node = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};
function walk(value: unknown, visit: (node: Node) => void) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  const node = value as Node;
  if (typeof node.type !== "string") return;
  visit(node);
  for (const [key, child] of Object.entries(node))
    if (!["loc", "comments", "tokens"].includes(key)) walk(child, visit);
}
export function instrumentPiOpenSource(source: string, kind: keyof typeof hashes) {
  assert.equal(createHash("sha256").update(source).digest("hex"), hashes[kind]);
  assert.equal(source.includes(observer), false);
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const nodes: Node[] = [];
  walk(ast, (node) => nodes.push(node));
  const unique = (matches: Node[]) => {
    assert.equal(matches.length, 1, "Diagnostic must select one original source site");
    const match = matches[0];
    assert.ok(match);
    return match;
  };
  const scope = (name: string) =>
    unique(
      nodes.filter(
        (n) => n.type === "FunctionDeclaration" && (n.id as { name?: string })?.name === name,
      ),
    );
  const sites: { phase: string; start: number; end: number }[] = [];
  const mark = (parent: Node, phase: string, prefix: string) => {
    const selected: Node[] = [];
    walk(parent, (n) => {
      if (
        ["ExpressionStatement", "VariableDeclaration"].includes(n.type) &&
        source.slice(n.start, n.end).startsWith(prefix)
      )
        selected.push(n);
    });
    const node = unique(selected);
    sites.push({ phase, start: node.start, end: node.end });
  };
  if (kind === "sdk") {
    mark(scope("_open"), "pi-ready", "await this.lifecycle.ready()");
    const open = scope("_doOpen");
    for (const [phase, prefix] of [
      ["pi-last-close", "await _classPrivateFieldGet2(_lastClose, this)"],
      ["pi-session-store", "const storage = await openPiSessionStore("],
      ["pi-harness-factory", "const pi = await _classPrivateFieldGet2(_options, this).harness("],
      ["pi-root", "await pi.root("],
      ["pi-resume", "pi.resume()"],
      ["pi-open-timer", "await new Promise((resolve) => setTimeout(resolve, 0))"],
      ["pi-open-wake", "await _assertClassBrand(_PiHarness_brand, this, _wakeFor).call("],
    ] as const)
      mark(open, phase, prefix);
  } else {
    const property = unique(
      nodes.filter(
        (n) => n.type === "ObjectProperty" && (n.key as { name?: string })?.name === "harness",
      ),
    );
    const factory = property.value as Node;
    mark(factory, "pi-factory-store", "await this.store.open()");
    mark(factory, "pi-factory-models", "const models = unwrap(await this.#models())");
    mark(factory, "pi-factory-harness", "const harness = await Harness.open(");
  }
  const inserts = sites
    .flatMap(({ phase, start, end }) => [
      { at: start, text: `${observer}(${JSON.stringify(phase)}, "enter");\n` },
      { at: end, text: `\n${observer}(${JSON.stringify(phase)}, "exit");` },
    ])
    .sort((a, b) => b.at - a.at);
  let contents = source;
  for (const { at, text } of inserts) contents = contents.slice(0, at) + text + contents.slice(at);
  contents += `\nfunction ${observer}(phase, event) { try {
    if (!${JSON.stringify(piOpenPhases)}.includes(phase) || !["enter", "exit"].includes(event)) return;
    console.log(JSON.stringify({ diagnostic: "recovery-inspection", phase, event }));
  } catch {} }\n`;
  return { contents, sites };
}

export function piOpenObservationPlugin(repository: string, enabled: boolean): Plugin {
  return {
    name: "fixed-pi-open-observations",
    setup(builder) {
      if (!enabled) return;
      const require = createRequire(resolve(repository, "apps/worker/package.json"));
      const sdk = require.resolve("agents/harness/pi");
      const factory = resolve(repository, "apps/worker/src/agent/agent-session.ts");
      const loaded = { sdk: 0, factory: 0 };
      builder.onLoad({ filter: /\.(?:js|ts)$/ }, async (args) => {
        const kind =
          resolve(args.path) === sdk ? "sdk" : resolve(args.path) === factory ? "factory" : null;
        if (!kind) return undefined;
        loaded[kind]++;
        const original = await readFile(args.path, "utf8");
        return {
          contents: instrumentPiOpenSource(original, kind).contents,
          loader: kind === "sdk" ? "js" : "ts",
        };
      });
      builder.onEnd(() => {
        assert.deepEqual(
          loaded,
          { sdk: 1, factory: 1 },
          "Both original diagnostic sources must be loaded once",
        );
      });
    },
  };
}
