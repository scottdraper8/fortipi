import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "@babel/parser";
import {
  instrumentQueuedProjectionRegistry,
  queuedProjectionGateSite,
} from "./queued-projection-compiler.ts";

const path = resolve(import.meta.dirname, "../../src/execution/registry.ts");
const ast = (source: string) => parse(source, { sourceType: "module", plugins: ["typescript"] });
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized).filter((v) => v !== undefined);
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const expression = node.expression as
    | { argument?: { callee?: { property?: { name?: string } } } }
    | undefined;
  const call =
    expression?.argument ?? (node.expression as { callee?: { property?: { name?: string } } });
  if (
    node.type === "ExpressionStatement" &&
    ["holdQueuedProjection", "observeQueuedProjectionResult"].includes(
      call?.callee?.property?.name ?? "",
    )
  )
    return undefined;
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
            "tokens",
            "leadingComments",
            "trailingComments",
            "innerComments",
          ].includes(key),
      )
      .map(([key, v]) => [key, normalized(v)]),
  );
}
test("queued-projection compiler gates only the actual mapped projection phase and preserves original AST", async () => {
  const source = await readFile(path, "utf8"),
    observed = instrumentQueuedProjectionRegistry(source);
  assert.deepEqual(normalized(ast(observed)), normalized(ast(source)));
  assert.equal(observed.split(".holdQueuedProjection(").length - 1, 1);
  assert.throws(() => instrumentQueuedProjectionRegistry(`${source}\n`), assert.AssertionError);
  for (const method of ["entries", "advance"]) {
    const variant = source.replace(
      /await projection\.(?:entries|advance)\(mapped.conversationId\)/,
      `await projection.${method}(mapped.conversationId)`,
    );
    assert.equal(queuedProjectionGateSite(variant), queuedProjectionGateSite(source));
  }
  const withoutMapped = source.replace("if (mapped) {", "if (false) {");
  assert.throws(() => queuedProjectionGateSite(withoutMapped), assert.AssertionError);
});
