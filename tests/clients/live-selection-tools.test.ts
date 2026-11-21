// Controlled public records/HTTP, actual SDK byte transport and pinned Pi
// validation. These controls are NOT a model/provider/deployment witness.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { FortiPiClient } from "../../packages/fortipi-client/dist/node.js";
import { protocol } from "../../packages/fortipi-client/test/fixtures/wire.ts";
import { sha256 } from "../../scripts/verify-release-gates.ts";
import {
  parseSelectionExport,
  rawNativeDispatch,
  selectionAttempt,
  selectionExport,
  selectionExportScope,
} from "./live-selection-tools.ts";

const a = { kind: "executor" as const, executorId: "native-a", generation: 1 },
  b = { ...a, executorId: "native-b" };
const diagnostic = "No currently eligible configured target accepts these tool arguments";
function fixture() {
  const context = {
    routing: { kind: "prefer-local", targetIds: [a.executorId, b.executorId] },
    argumentContracts: { "native-shell": "An object containing command: string" },
    targets: [a, b].map((target) => ({
      target,
      argumentFormat: "native-shell",
      platform: "linux",
      capabilities: ["shell"],
    })),
    workspaces: [
      {
        workspaceId: "workspace",
        bindingVersion: 1,
        baseRevision: "r0",
        provider: "computer",
        configured: true,
        targets: [a, b],
      },
    ],
  };
  const dispatch = {
    tool: "shell",
    arguments: { command: "cat notes.txt" },
    capabilities: ["shell"],
    workspaceId: "workspace",
    baseRevision: "r0",
    target: structuredClone(a),
  };
  const entries = [
    {
      id: 1,
      kind: "pi.assistant",
      byTaskId: 7,
      model: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "inspect",
              name: "fortipi_context",
              arguments: { tool: "shell", capabilities: ["shell"] },
            },
          ],
        },
      ],
    },
    {
      id: 2,
      kind: "pi.tool-result",
      byTaskId: 8,
      model: [
        {
          role: "toolResult",
          timestamp: 100,
          toolCallId: "inspect",
          toolName: "fortipi_context",
          isError: false,
          content: [{ type: "text", text: JSON.stringify(context) }],
        },
      ],
      data: { diagnostics: [] },
    },
    {
      id: 3,
      kind: "pi.assistant",
      byTaskId: 9,
      model: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "attempt", name: "fortipi_dispatch", arguments: dispatch },
          ],
        },
      ],
    },
    {
      id: 4,
      kind: "pi.tool-result",
      byTaskId: 10,
      model: [
        {
          role: "toolResult",
          timestamp: 100,
          toolCallId: "attempt",
          toolName: "fortipi_dispatch",
          isError: true,
          content: [{ type: "text", text: `<harness>\n[error] ${diagnostic}\n</harness>` }],
        },
      ],
      data: { diagnostics: [{ severity: "error", code: "tool_error", message: diagnostic }] },
    },
  ];
  const rows: Record<string, unknown>[] = [
    { type: "fortipi.agent.export", version: 1, exportId: "export", agentId: "agent" },
    {
      type: "conversation",
      conversation: { agentId: "agent", conversationId: "conversation" },
      through: 6,
      piEntryThrough: 4,
    },
    {
      type: "message",
      conversationId: "conversation",
      message: { messageId: "user", role: "user", content: "Use the inspected device." },
    },
    ...entries.map((entry) => ({ type: "entry", conversationId: "conversation", entry })),
    {
      type: "task",
      task: {
        conversationId: "conversation",
        taskId: "task",
        version: 1,
        status: { state: "completed" },
      },
    },
  ];
  return {
    rows,
    dispatch,
    entries,
    bytes: () => Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
    expected: {
      workspaceId: "workspace",
      baseRevision: "r0",
      targets: [a, b],
      ranked: [a.executorId, b.executorId],
      selected: a,
      mode: "explicit" as const,
      refusal: diagnostic as typeof diagnostic,
    },
  };
}
function witness(f = fixture()) {
  return selectionAttempt(
    parseSelectionExport(f.bytes(), "agent", "conversation", ["synthetic-secret-value"]),
    f.expected,
  );
}
test("raw exported cached attempt distinguishes a valid refusal from coercion, malformed native payloads and wrong associations", async () => {
  assert.equal(witness().arguments.arguments.command, "cat notes.txt");
  const require = createRequire(new URL("../../apps/worker/package.json", import.meta.url));
  const validation = await import(
    new URL(
      "../../pi-ai/dist/utils/validation.js",
      pathToFileURL(require.resolve("@earendil-works/pi-durable")),
    ).href
  );
  const raw = fixture();
  (raw.dispatch.target as unknown as { generation: string }).generation = "1";
  const coerced = validation.validateToolArguments(
    {
      name: "fortipi_dispatch",
      parameters: {
        type: "object",
        properties: { target: { type: "object", properties: { generation: { type: "integer" } } } },
      },
    },
    { id: "attempt", name: "fortipi_dispatch", arguments: raw.dispatch },
  );
  assert.equal(coerced.target.generation, 1);
  assert.equal(raw.dispatch.target.generation as unknown, "1");
  assert.throws(() => witness(raw));
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      (f.dispatch as unknown as { capabilities: string }).capabilities = "shell";
    },
    (f: ReturnType<typeof fixture>) => {
      (f.dispatch.arguments as unknown) = { source: "cat notes.txt" };
    },
    (f: ReturnType<typeof fixture>) => {
      (f.dispatch.arguments as unknown) = { command: 42 };
    },
    (f: ReturnType<typeof fixture>) => {
      (f.dispatch as unknown as { target: null }).target = null;
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.dispatch, { extra: true });
    },
    (f: ReturnType<typeof fixture>) => {
      f.dispatch.baseRevision = "new-base";
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.entries[3]!.model[0]!, { toolCallId: "unrelated" });
    },
    (f: ReturnType<typeof fixture>) => {
      f.rows.splice(5, 2);
    },
    (f: ReturnType<typeof fixture>) => {
      f.rows.push({ type: "credential", token: "synthetic-secret-value" });
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => witness(f));
  }
  for (const command of ["\0", "x".repeat(65537)])
    assert.throws(() => rawNativeDispatch({ ...fixture().dispatch, arguments: { command } }));
});

test("actual installed SDK public binary path verifies complete scoped export bytes, hash and cut", async () => {
  let fault = "",
    observedScope: unknown;
  const f = fixture(),
    token = "synthetic-export-role-1010";
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/protocol") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(protocol));
      return;
    }
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === "/v1/admin/exports") {
      let body = "";
      for await (const chunk of request) body += chunk;
      observedScope = JSON.parse(body).resources;
      response.statusCode = 202;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          operationId: "operation",
          kind: "export",
          state: "completed",
          artifacts: [
            {
              artifactId: "artifact",
              endpoint: "/v1/admin/artifacts/artifact",
              size: f.bytes().length,
              sha256: sha256(f.bytes()),
              scope: {
                kind: "agent",
                agentId: "agent",
                conversationIds: [fault === "scope" ? "foreign" : "conversation"],
              },
            },
          ],
        }),
      );
      return;
    }
    assert.equal(request.url, "/v1/admin/artifacts/artifact");
    const bytes =
      fault === "cut"
        ? Buffer.from(f.bytes().toString().replace('"piEntryThrough":4', '"piEntryThrough":2'))
        : f.bytes();
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("content-length", bytes.length);
    response.setHeader("x-content-sha256", fault === "hash" ? "0".repeat(64) : sha256(bytes));
    response.end(bytes);
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new FortiPiClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      allowLoopbackHttp: true,
      credentials: async () => token,
    });
    const first = await selectionExport(client, "agent", "conversation", [token]);
    assert.equal(first.transcript.calls.length, 2);
    assert.deepEqual(observedScope, {
      ...selectionExportScope("agent", "conversation"),
      actions: [],
    });
    for (fault of ["scope", "hash", "cut"])
      await assert.rejects(selectionExport(client, "agent", "conversation", [token]));
  } finally {
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
});

test("two source mutants demonstrate native-argument and call-association oracle sensitivity", async () => {
  await mkdir(resolve(import.meta.dirname, "../../.agent-docs/tmp"), {
    recursive: true,
    mode: 0o700,
  });
  const directory = await mkdtemp(
    resolve(import.meta.dirname, "../../.agent-docs/tmp/selection-mutants-"),
  );
  try {
    const original = await readFile(new URL("./live-selection-tools.ts", import.meta.url), "utf8");
    const absolute = original
      .replace(
        '"../../scripts/verify-release-gates.ts"',
        JSON.stringify(new URL("../../scripts/verify-release-gates.ts", import.meta.url).href),
      )
      .replace(
        '"./live-device.ts"',
        JSON.stringify(new URL("./live-device.ts", import.meta.url).href),
      );
    const native = absolute.replace(
      "const args = rawNativeDispatch(dispatch.arguments);",
      "const args = dispatch.arguments as unknown as RawDispatch;",
    );
    assert.notEqual(native, absolute);
    const association = absolute.replace(
      "`${text(m.toolCallId)}:${m.toolName}`",
      "`${[...pending.values()][0]!.call.id}:${m.toolName}`",
    );
    assert.notEqual(association, absolute);
    for (const [name, source] of [
      ["native", native],
      ["association", association],
    ]) {
      const path = resolve(directory, `${name}.ts`);
      await writeFile(path, source!);
      const mutant = await import(pathToFileURL(path).href);
      const f = fixture();
      if (name === "native")
        (f.dispatch.arguments as unknown) = { source: "incompatible-but-same-diagnostic" };
      else Object.assign(f.entries[3]!.model[0]!, { toolCallId: "unrelated" });
      assert.throws(() => witness(f));
      assert.doesNotThrow(() =>
        mutant.selectionAttempt(
          mutant.parseSelectionExport(f.bytes(), "agent", "conversation", [
            "synthetic-secret-value",
          ]),
          f.expected,
        ),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
