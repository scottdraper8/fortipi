// Diagnostic compilation only; never modify installed SDK or production source bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
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
  "recovery-job-drain",
  "drain-controls",
  "drain-reconciliation",
  "drain-fresh-jobs",
  "drain-dispatch",
  "drain-projection",
  "drain-exports",
  "chord-transaction-request",
  "chord-queue-operation",
  "chord-storage-callback",
  "pi-commit-transaction",
  "pi-commit-publication",
  "router-state-ingress",
  "storage-observation-limit",
] as const;
const observer = "__fortipiPiOpenObservation";
const counter = `${observer}Count`;
export const observationRecordLimit = 4096;
const hashes = {
  sdk: "260e3af51748cb7eade4a6a1546f23d0bf515fda155b5e8029845e82bb85d5e7",
  factory: "2f235cdc46174819060aaa1c3800ad0448d770dc5126a748216ce70077c798f9",
  recovery: "2bfca997ccd532552b5136709b8df9bbacf4873d3f4ea8728397ca59cbe62cd8",
  chord: "49eaad4430e684782b03c23c4decabb7f77a8f40974773f73529ff8e7ca19382",
  piStorage: "0d9d8cf56898afe5d38f0e56bd3cbcad23a8e68b942b81c39587ac731fe48642",
  router: "78cd860fd35c675c89952aabe0ea1cb5e88e51382c015cfbc1b935525e256780",
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
  const sites: {
    phase: string;
    start: number;
    end: number;
    mode?: "enter" | "sequence" | "guard";
  }[] = [];
  const mark = (parent: Node, phase: string, prefix: string) => {
    const selected: Node[] = [];
    walk(parent, (n) => {
      if (
        ["ExpressionStatement", "VariableDeclaration", "ForOfStatement"].includes(n.type) &&
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
  } else if (kind === "factory") {
    const property = unique(
      nodes.filter(
        (n) => n.type === "ObjectProperty" && (n.key as { name?: string })?.name === "harness",
      ),
    );
    const factory = property.value as Node;
    mark(factory, "pi-factory-store", "await this.store.open()");
    mark(factory, "pi-factory-models", "const models = unwrap(await this.#models())");
    mark(factory, "pi-factory-harness", "const harness = await Harness.open(");
    const drain = unique(
      nodes.filter(
        (n) =>
          n.type === "ClassPrivateMethod" &&
          (n.key as { id?: { name?: string } })?.id?.name === "drain",
      ),
    );
    for (const [phase, prefix] of [
      ["drain-controls", "const control = await this.controls.drain("],
      ["drain-reconciliation", "const reconciliation = await this.reconciliation.drain("],
      ["drain-fresh-jobs", "const fresh = await this.freshJobs.drain("],
      ["drain-dispatch", "const jobs = await this.dispatch.repair("],
      ["drain-projection", "const projection = await this.projection.drain("],
      ["drain-exports", "const exports = await this.exports.drain("],
    ] as const)
      mark(drain, phase, prefix);
  } else if (kind === "recovery") {
    const job = unique(
      nodes.filter((n) => n.type === "ClassMethod" && (n.key as { name?: string })?.name === "job"),
    );
    mark(job, "recovery-job-drain", "progress = await this.drain(");
  } else if (kind === "chord") {
    const transaction = unique(
      nodes.filter(
        (n) => n.type === "ClassMethod" && (n.key as { name?: string })?.name === "transaction",
      ),
    );
    const returned = ((transaction.body as Node).body as Node[])[0]!;
    assert.equal(returned.type, "ReturnStatement");
    sites.push({
      phase: "chord-transaction-request",
      start: returned.start,
      end: returned.end,
      mode: "enter",
    });
    const queued = ((returned.argument as Node).arguments as Node[])[0]!;
    const operation = queued.body as Node;
    assert.equal(operation.type, "CallExpression");
    assert.equal(
      source.slice(operation.start, operation.end).startsWith("this.storage.transaction("),
      true,
    );
    sites.push({
      phase: "chord-queue-operation",
      start: operation.start,
      end: operation.end,
      mode: "sequence",
    });
    const callback = (operation.arguments as Node[])[0]!;
    const callbackBody = callback.body as Node;
    const finalizer = unique((callbackBody.body as Node[]).filter((n) => n.type === "TryStatement"))
      .finalizer as Node;
    sites.push({
      phase: "chord-storage-callback",
      start: callbackBody.start + 1,
      end: finalizer.end - 1,
    });
  } else if (kind === "piStorage") {
    const commit = unique(
      nodes.filter(
        (n) => n.type === "ClassMethod" && (n.key as { name?: string })?.name === "commit",
      ),
    );
    mark(commit, "pi-commit-transaction", "await this.db.transaction(");
    mark(commit, "pi-commit-publication", "for (const [index, seq] of seqs.entries())");
  } else {
    const assignment = unique(
      nodes.filter(
        (n) =>
          n.type === "ExpressionStatement" &&
          source.slice(n.start, n.end) === "url.pathname = `/__test/${match[2]}`;",
      ),
    );
    sites.push({
      phase: "router-state-ingress",
      start: assignment.start,
      end: assignment.end,
      mode: "guard",
    });
  }
  const inserts = sites
    .flatMap(({ phase, start, end, mode }) => {
      const call = `${observer}(${JSON.stringify(phase)}, "enter")`;
      if (mode === "sequence")
        return [
          { at: start, text: `(${call}, ` },
          { at: end, text: ")" },
        ];
      if (mode === "enter") return [{ at: start, text: `${call};\n` }];
      if (mode === "guard") return [{ at: start, text: `if (match[2] === "state") ${call};\n` }];
      return [
        { at: start, text: `${call};\n` },
        { at: end, text: `\n${observer}(${JSON.stringify(phase)}, "exit");` },
      ];
    })
    .sort((a, b) => b.at - a.at);
  let contents = source;
  for (const { at, text } of inserts) contents = contents.slice(0, at) + text + contents.slice(at);
  contents += `\nlet ${counter} = 0;
function ${observer}(phase, event) { try {
    if (!${JSON.stringify(piOpenPhases)}.includes(phase) || !["enter", "exit"].includes(event)) return;
    if (${counter} >= ${observationRecordLimit}) {
      if (${counter} === ${observationRecordLimit}) { ${counter}++; console.log(JSON.stringify({ diagnostic: "recovery-inspection", phase: "storage-observation-limit", event: "enter" })); }
      return;
    }
    ${counter}++;
    console.log(JSON.stringify({ diagnostic: "recovery-inspection", phase, event }));
  } catch {} }\n`;
  return { contents, sites };
}

export function piOpenObservationSources(repository: string) {
  const require = createRequire(resolve(repository, "apps/worker/package.json"));
  return {
    sdk: require.resolve("agents/harness/pi"),
    factory: resolve(repository, "apps/worker/src/agent/agent-session.ts"),
    recovery: resolve(repository, "apps/worker/src/agent/recovery.ts"),
    chord: realpathSync(
      resolve(
        repository,
        "apps/worker/node_modules/@earendil-works/chord/dist/sqlite/cloudflare.js",
      ),
    ),
    piStorage: resolve(
      dirname(require.resolve("@earendil-works/pi-durable/storage/sqlite/cloudflare")),
      "storage.js",
    ),
    router: resolve(repository, "apps/worker/test/agent/runtime-worker.ts"),
  };
}

export function piOpenObservationPlugin(repository: string, enabled: boolean): Plugin {
  return {
    name: "fixed-pi-open-observations",
    setup(builder) {
      if (!enabled) return;
      const sources = piOpenObservationSources(repository);
      const loaded = { sdk: 0, factory: 0, recovery: 0, chord: 0, piStorage: 0, router: 0 };
      builder.onLoad({ filter: /\.(?:js|ts)$/ }, async (args) => {
        const kind = (Object.keys(sources) as (keyof typeof sources)[]).find(
          (kind) => resolve(args.path) === sources[kind],
        );
        if (!kind) return undefined;
        loaded[kind]++;
        const original = await readFile(args.path, "utf8");
        return {
          contents: instrumentPiOpenSource(original, kind).contents,
          loader: ["sdk", "chord", "piStorage"].includes(kind) ? "js" : "ts",
        };
      });
      builder.onEnd(() => {
        assert.deepEqual(
          loaded,
          { sdk: 1, factory: 1, recovery: 1, chord: 1, piStorage: 1, router: 1 },
          "Every pinned diagnostic source must be loaded once",
        );
      });
    },
  };
}
