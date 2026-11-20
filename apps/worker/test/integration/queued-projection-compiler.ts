import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { parse } from "@babel/parser";
import { build } from "esbuild";

const repository = resolve(import.meta.dirname, "../../../..");
// Original ANY-pending control and the parent's separately frozen per-entry fence.
export const queuedProjectionRegistrySha256 =
  "17a6139ea82337eaaab5e7b493a2f1fc9204b8c9a43726156b6ab0611b56b855";
export const queuedProjectionFixedRegistrySha256 =
  "163703de2910d49fc2e445ec5a9afccc456d71ed0f9a17c6bc7e31b25335775b";
export const queuedProjectionGateCall =
  "await (conversations.host as unknown as { holdQueuedProjection(piId: number, caller: number): Promise<void> }).holdQueuedProjection(task.input.conversationId, runtime.taskId);\n";
type Node = { type: string; start: number; end: number; [key: string]: unknown };
function walk(value: unknown, visit: (node: Node, parents: Node[]) => void, parents: Node[] = []) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit, parents);
    return;
  }
  const node = value as Node;
  if (typeof node.type !== "string") return;
  visit(node, parents);
  for (const [key, child] of Object.entries(node))
    if (!["loc", "comments", "tokens"].includes(key)) walk(child, visit, [...parents, node]);
}
function projectionSite(source: string) {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const matches: { start: number; end: number; result: string }[] = [];
  walk(ast, (node, parents) => {
    if (node.type !== "VariableDeclaration") return;
    const declaration = (node.declarations as Node[])[0];
    const awaited = declaration?.init as Node | undefined;
    const call = awaited?.argument as Node | undefined;
    const member = call?.callee as { object?: { name?: string }; property?: { name?: string } };
    if (
      awaited?.type !== "AwaitExpression" ||
      member?.object?.name !== "projection" ||
      !["entries", "advance"].includes(member.property?.name ?? "")
    )
      return;
    const owner = parents.find(
      (n) => n.type === "VariableDeclarator" && (n.id as { name?: string })?.name === "projectTask",
    );
    const phase = parents.find(
      (n) => n.type === "ObjectProperty" && (n.key as { name?: string })?.name === "project",
    );
    const mapped = parents.find(
      (n) => n.type === "IfStatement" && (n.test as { name?: string })?.name === "mapped",
    );
    if (!owner || !phase || !mapped) return;
    assert.ok(call);
    const conversation = (call.arguments as Node[])[0];
    assert.ok(conversation);
    assert.equal(source.slice(conversation.start, conversation.end), "mapped.conversationId");
    const phaseValue = phase.value as Node;
    assert.equal(
      parents.filter((n) => n.type === "ArrowFunctionExpression" && n.start >= phaseValue.start)
        .length,
      1,
    );
    assert.ok(source.slice(owner.start, phaseValue.start).includes('name: "fortipi.project"'));
    assert.ok(declaration);
    const binding = declaration.id as { type?: string; name?: string };
    assert.ok(binding.type === "Identifier" && binding.name);
    matches.push({
      start: node.start,
      end: node.end,
      result: member.property?.name === "entries" ? binding.name : `${binding.name}.more`,
    });
  });
  assert.equal(matches.length, 1, "Gate must select the actual mapped fortipi.project phase once");
  const selected = matches[0];
  assert.ok(selected);
  return selected;
}
export function queuedProjectionGateSite(source: string): number {
  return projectionSite(source).start;
}
export function instrumentQueuedProjectionRegistry(source: string) {
  assert.ok(
    [queuedProjectionRegistrySha256, queuedProjectionFixedRegistrySha256].includes(
      createHash("sha256").update(source).digest("hex"),
    ),
    "Only the frozen original or per-entry registry may receive the test gate",
  );
  assert.equal(source.includes("holdQueuedProjection"), false);
  const site = projectionSite(source);
  const returned = `\n(conversations.host as unknown as { observeQueuedProjectionResult(piId: number, caller: number, more: boolean): void }).observeQueuedProjectionResult(task.input.conversationId, runtime.taskId, ${site.result});\n`;
  return (
    source.slice(0, site.start) +
    queuedProjectionGateCall +
    source.slice(site.start, site.end) +
    returned +
    source.slice(site.end)
  );
}
export async function compileQueuedProjectionFixture(directory: string) {
  const registry = join(repository, "apps/worker/src/execution/registry.ts");
  let loaded = 0;
  const main = join(directory, "queued-projection-worker.js");
  await build({
    entryPoints: [join(import.meta.dirname, "queued-projection-worker.ts")],
    outfile: main,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    mainFields: ["browser", "module", "main"],
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*", ...builtinModules],
    loader: { ".yaml": "json" },
    logLevel: "silent",
    plugins: [
      {
        name: "queued-projection-actual-phase-gate",
        setup(builder) {
          builder.onLoad({ filter: /registry\.ts$/ }, async (args) => {
            if (resolve(args.path) !== registry) return;
            loaded++;
            return {
              contents: instrumentQueuedProjectionRegistry(await readFile(args.path, "utf8")),
              loader: "ts",
            };
          });
          builder.onEnd(() =>
            assert.equal(loaded, 1, "Real registry must be compiled exactly once"),
          );
        },
      },
    ],
  });
  return main;
}
