import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { parse } from "@babel/parser";
import type * as T from "@babel/types";
import type { Tool } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import Ajv from "ajv/dist/2020.js";

function literal(node: T.Node, bindings: Map<string, unknown>): unknown {
  if (node.type === "TSAsExpression") return literal(node.expression, bindings);
  if (node.type === "Identifier") {
    assert.ok(bindings.has(node.name), "Unknown schema data reference");
    return bindings.get(node.name);
  }
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    const value = literal(node.object, bindings);
    assert.ok(value !== null && typeof value === "object");
    assert.ok(Object.hasOwn(value, node.property.name));
    return (value as Record<string, unknown>)[node.property.name];
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier"
  ) {
    assert.equal(node.arguments.length, 1);
    const argument = node.arguments[0];
    assert.ok(argument);
    if (
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "Object" &&
      node.callee.property.name === "values"
    ) {
      const value = literal(argument, bindings);
      assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
      return Object.values(value);
    }
    if (node.callee.property.name === "join") {
      const values = literal(node.callee.object, bindings),
        separator = literal(argument, bindings);
      assert.ok(Array.isArray(values) && values.every((value) => typeof value === "string"));
      assert.equal(typeof separator, "string");
      return values.join(separator as string);
    }
  }
  if (node.type === "ObjectExpression")
    return Object.fromEntries(
      node.properties.map((property) => {
        assert.equal(property.type, "ObjectProperty");
        assert.ok(property.key.type === "Identifier" || property.key.type === "StringLiteral");
        return [
          property.key.type === "Identifier" ? property.key.name : property.key.value,
          literal(property.value, bindings),
        ];
      }),
    );
  if (node.type === "ArrayExpression")
    return node.elements.map((item) => {
      assert.ok(item);
      return literal(item, bindings);
    });
  if (
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BooleanLiteral"
  )
    return node.value;
  throw new Error("Production tool schema is no longer a literal; update the independent capture");
}
async function parameters(): Promise<Record<string, Record<string, unknown>>> {
  const bindings = new Map<string, unknown>();
  const wanted = new Set(["argumentContracts", "parameters", "contextParameters"]);
  for (const file of ["tool-arguments", "registry"]) {
    const source = await readFile(
      fileURLToPath(new NodeURL(`../../src/execution/${file}.ts`, import.meta.url)),
      "utf8",
    );
    const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
    for (const statement of ast.program.body) {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (declaration?.type === "VariableDeclaration")
        for (const item of declaration.declarations)
          if (item.id.type === "Identifier" && wanted.has(item.id.name) && item.init) {
            assert.ok(!bindings.has(item.id.name), "Duplicate schema data binding");
            bindings.set(item.id.name, literal(item.init, bindings));
          }
    }
  }
  assert.ok(
    bindings.has("parameters") && bindings.has("contextParameters"),
    "Canonical production tool schemas missing",
  );
  return {
    fortipi_dispatch: bindings.get("parameters") as Record<string, unknown>,
    fortipi_context: bindings.get("contextParameters") as Record<string, unknown>,
  };
}
async function capture(tool: Tool): Promise<Record<string, unknown>> {
  const models = createModels({
    credentials: {
      read: async () => ({ type: "api_key", key: "synthetic-schema-probe" }),
      list: async () => [{ providerId: "anthropic", type: "api_key" }],
      modify: async () => {
        throw new Error("Unexpected credential mutation");
      },
      delete: async () => {
        throw new Error("Unexpected credential deletion");
      },
    },
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(anthropicProvider());
  const selected = models.getModel("anthropic", "claude-opus-4-7");
  assert.ok(selected);
  let sent: Record<string, unknown> | undefined,
    calls = 0;
  const answer = await models.completeSimple(
    selected,
    {
      messages: [{ role: "user", content: "schema capture", timestamp: Date.now() }],
      tools: [tool],
    },
    {
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(new URL(request.url).origin, "https://api.anthropic.com");
        const payload = (await request.json()) as { tools: Record<string, unknown>[] };
        assert.equal(payload.tools.length, 1);
        sent = payload.tools[0];
        calls++;
        return Response.json(
          {
            error: {
              type: "invalid_request_error",
              message: "Synthetic capture completed; no external provider",
            },
          },
          { status: 400 },
        );
      },
    },
  );
  assert.equal(calls, 1, "Capture must reach the actual provider request exactly once");
  assert.equal(answer.stopReason, "error", "This is wire capture, not provider success");
  assert.ok(sent);
  return sent;
}
test("actual pinned Anthropic conveys the production dispatch closed-root schema", async () => {
  // Oracle: official aa47cedce0a5347232ac2ad04c67594f4b3ad5cc and the
  // canonical tool's declared JSON Schema. Do not accept provider omission.
  for (const [name, schema] of Object.entries(await parameters())) {
    assert.equal(schema.additionalProperties, false);
    const valid = new Ajv({ strict: true }).compile(schema);
    const input =
      name === "fortipi_context"
        ? { tool: "shell", capabilities: [] }
        : {
            tool: "shell",
            arguments: { command: "printf schema-probe" },
            workspaceId: "workspace",
            baseRevision: "base",
            target: { kind: "executor", executorId: "executor", generation: 1 },
            capabilities: [],
          };
    assert.equal(valid(input), true);
    if (name === "fortipi_dispatch") {
      const { baseRevision: _base, ...missingBase } = input;
      assert.equal(valid(missingBase), false, "Dispatch still requires the observed current base");
    }
    assert.equal(valid({ ...input, unexpectedRootArgument: true }), false);
    assert.equal(valid({ ...input, agentId: "caller-cannot-select-authority" }), false);
    for (const tool of ["file.read", "workspace.read"])
      assert.equal(valid({ ...input, tool }), false, "A capability is not an executable tool");
    const sent = await capture({
      name,
      description: "Exact production wrapper parameters",
      parameters: schema,
    });
    const actual = sent.input_schema as Record<string, unknown>;
    assert.equal(sent.strict, undefined);
    assert.equal(
      actual.additionalProperties,
      false,
      "Actual selected adapter must convey the declared closed root schema",
    );
    assert.deepEqual(actual.properties, schema.properties);
    assert.deepEqual(actual.required, schema.required);
  }
});
test("Anthropic preserves explicit false, true and schema values without inventing omitted keywords", async () => {
  for (const value of [false, true, { type: "string" }, undefined]) {
    const schema = {
      type: "object",
      title: "non-strict root title stays filtered",
      properties: { value: { type: "string" } },
      required: ["value"],
      ...(value === undefined ? {} : { additionalProperties: value }),
    } as const;
    const sent = await capture({
      name: "schema_control",
      description: "Root keyword control",
      parameters: schema,
    });
    const actual = sent.input_schema as Record<string, unknown>;
    assert.equal(sent.strict, undefined);
    assert.equal(actual.title, undefined);
    assert.equal(Object.hasOwn(actual, "additionalProperties"), value !== undefined);
    if (value !== undefined) assert.deepEqual(actual.additionalProperties, value);
    assert.deepEqual(actual.properties, schema.properties);
  }
});
test("Anthropic strict tool mode retains its complete original schema", async () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { value: { type: "string" } },
    required: ["value"],
  } as const;
  const strict = await capture({
    name: "strict_control",
    description: "Existing strict path",
    parameters: schema,
    constrainedSampling: { type: "json_schema", strict: "require" },
  });
  assert.equal(strict.strict, true);
  assert.deepEqual(strict.input_schema, schema);
});
