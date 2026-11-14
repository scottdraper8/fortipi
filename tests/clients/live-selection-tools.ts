import { randomUUID } from "node:crypto";
import type { FortiPiClient } from "../../packages/fortipi-client/dist/node.js";
import type { BackendRef, ResourceScope } from "../../packages/fortipi-contract/dist/index.js";
import { canonicalJson, sha256 } from "../../scripts/verify-release-gates.ts";
import { deviceReadRequests } from "./live-device.ts";

const failure = "Selection public tool witness unavailable or inconsistent";
export const selectionCases = [
  "preferred-a",
  "preferred-b",
  "override-a",
  "stale-revision",
  "stale-executor",
  "expired-grant",
] as const;
export type SelectionCase = (typeof selectionCases)[number];
export type NativeTarget = Extract<BackendRef, { kind: "executor" }>;
export const emptySelectionScope = (): ResourceScope => ({
  agentIds: [],
  conversationIds: [],
  workspaceIds: [],
  executorIds: [],
  backendIds: [],
  tools: [],
  actions: [],
});
export function selectionExportScope(agentId: string, conversationId: string): ResourceScope {
  return {
    ...emptySelectionScope(),
    agentIds: [agentId],
    conversationIds: [conversationId],
    actions: ["exports.create", "operations.read", "artifacts.read"],
  };
}
function requireValue(test: unknown): asserts test {
  if (!test) throw new Error(failure);
}
export function rawObject(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  requireValue(
    required.every((key) => Object.hasOwn(row, key)) &&
      Object.keys(row).every((key) => required.includes(key) || optional.includes(key)),
  );
  return row;
}
function text(value: unknown, max = 128): string {
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= max &&
      !value.includes("\0"),
  );
  return value;
}
function integer(value: unknown, min = 1): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= min);
  return value;
}
function strings(value: unknown): string[] {
  requireValue(Array.isArray(value) && value.length <= 100);
  return value.map((item) => text(item));
}
export function rawNativeTarget(value: unknown): NativeTarget {
  const row = rawObject(value, ["kind", "executorId", "generation"]);
  requireValue(row.kind === "executor");
  return {
    kind: "executor",
    executorId: text(row.executorId),
    generation: integer(row.generation),
  };
}
export interface RawDispatch {
  tool: "shell";
  arguments: { command: string };
  workspaceId: string;
  baseRevision: string;
  capabilities: string[];
  target?: NativeTarget;
}
/** Deliberately does NOT use Pi/Ajv's coercing cloned-call validator. */
export function rawNativeDispatch(value: unknown): RawDispatch {
  const row = rawObject(
    value,
    ["tool", "arguments", "workspaceId", "baseRevision", "capabilities"],
    ["target"],
  );
  requireValue(row.tool === "shell");
  const args = rawObject(row.arguments, ["command"]);
  const result: RawDispatch = {
    tool: "shell",
    arguments: { command: text(args.command, 65536) },
    workspaceId: text(row.workspaceId),
    baseRevision: text(row.baseRevision),
    capabilities: strings(row.capabilities),
  };
  if (Object.hasOwn(row, "target")) result.target = rawNativeTarget(row.target);
  return result;
}
export interface SelectionContext {
  routing: { kind: "prefer-local"; targetIds: string[] };
  argumentContracts: Record<string, string>;
  targets: {
    target: NativeTarget;
    argumentFormat: string;
    platform?: string;
    capabilities: string[];
  }[];
  workspaces: {
    workspaceId: string;
    bindingVersion: number;
    baseRevision: string;
    provider: string;
    configured: boolean;
    targets: NativeTarget[];
  }[];
}
export interface SelectionCall {
  entryId: number;
  resultEntryId: number;
  byTaskId: number;
  resultTaskId: number;
  callId: string;
  name: "fortipi_context" | "fortipi_dispatch";
  arguments: Record<string, unknown>;
  result: { isError: boolean; content: { type: "text"; text: string }[]; diagnostics: unknown[] };
  resultSha256: string;
  resultTimestamp: number;
}
export interface SelectionTranscript {
  agentId: string;
  conversationId: string;
  through: number;
  piEntryThrough: number;
  messages: { messageId: string; role: string; content: string }[];
  calls: SelectionCall[];
  jobs: unknown[];
  tasks: unknown[];
}
/** Entire raw export remains in memory. Only selected bounded immutable facts
 * escape. No parser/provider error text or arbitrary transcript is retained. */
export function parseSelectionExport(
  bytes: Uint8Array,
  agentId: string,
  conversationId: string,
  secrets: readonly string[],
): SelectionTranscript {
  try {
    requireValue(bytes.byteLength > 0 && bytes.byteLength <= 1048576);
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    for (const secret of secrets) {
      requireValue(secret.length >= 1);
      requireValue(
        !source.includes(secret) && !source.includes(JSON.stringify(secret).slice(1, -1)),
      );
    }
    const lines = source.trimEnd().split("\n");
    requireValue(lines.length <= 4096);
    const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const checkFields = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        requireValue(
          !/^(?:token|access_token|accessToken|refresh_token|refreshToken|authorization|password|secret|apiKey|api_key|clientSecret)$/i.test(
            key,
          ),
        );
        checkFields(child);
      }
    };
    rows.forEach(checkFields);
    const header = rawObject(rows.shift(), ["type", "version", "exportId", "agentId"]);
    requireValue(
      header.type === "fortipi.agent.export" && header.version === 1 && header.agentId === agentId,
    );
    const cuts = rows.filter((row) => row.type === "conversation");
    requireValue(cuts.length === 1);
    const cut = rawObject(cuts[0], ["type", "conversation", "through", "piEntryThrough"]);
    const conversation = cut.conversation as Record<string, unknown>;
    requireValue(
      conversation.conversationId === conversationId && conversation.agentId === agentId,
    );
    const through = integer(cut.through, 0),
      piEntryThrough = integer(cut.piEntryThrough);
    const calls: SelectionCall[] = [],
      pending = new Map<
        string,
        { entry: Record<string, unknown>; call: Record<string, unknown> }
      >();
    const messages: SelectionTranscript["messages"] = [],
      jobs: unknown[] = [],
      tasks: unknown[] = [];
    let previous = 0;
    for (const row of rows) {
      requireValue(
        ["conversation", "message", "entry", "task", "job", "approval"].includes(String(row.type)),
      );
      // These are deliberately selected source record kinds, never auth tables.
      if (row.type === "conversation") continue;
      if (row.type === "entry" || row.type === "message")
        requireValue(row.conversationId === conversationId);
      if (row.type === "message") {
        const m = row.message as Record<string, unknown>;
        // User text is needed only to bind the case; never retain model analysis.
        if (m.role === "user")
          messages.push({
            messageId: text(m.messageId),
            role: "user",
            content: text(m.content, 4096),
          });
      } else if (row.type === "job" || row.type === "task" || row.type === "approval") {
        const selected = row[String(row.type)] as Record<string, unknown>;
        requireValue(
          selected &&
            selected.conversationId === conversationId &&
            (row.type === "task" || selected.agentId === agentId),
        );
        if (row.type === "job") jobs.push(selected);
        if (row.type === "task") tasks.push(selected);
      } else if (row.type === "entry") {
        const entry = row.entry as Record<string, unknown>,
          id = integer(entry.id);
        requireValue(id > previous && id <= piEntryThrough);
        previous = id;
        requireValue(Array.isArray(entry.model) || entry.model === undefined);
        for (const m of (entry.model ?? []) as Record<string, unknown>[]) {
          if (entry.kind === "pi.assistant" && m.role === "assistant") {
            requireValue(Array.isArray(m.content));
            for (const call of m.content as Record<string, unknown>[])
              if (call.type === "toolCall") {
                requireValue(call.name === "fortipi_context" || call.name === "fortipi_dispatch");
                const key = `${text(call.id)}:${call.name}`;
                requireValue(!pending.has(key));
                requireValue(
                  call.arguments &&
                    typeof call.arguments === "object" &&
                    !Array.isArray(call.arguments),
                );
                pending.set(key, { entry, call });
              }
          } else if (entry.kind === "pi.tool-result" && m.role === "toolResult") {
            const key = `${text(m.toolCallId)}:${m.toolName}`,
              found = pending.get(key);
            requireValue(found);
            requireValue(typeof m.isError === "boolean" && Array.isArray(m.content));
            const content = m.content.map((value) => {
              const t = rawObject(value, ["type", "text"]);
              requireValue(t.type === "text");
              return { type: "text" as const, text: text(t.text, 65536) };
            });
            const diagnostics =
              (entry.data as { diagnostics?: unknown[] } | undefined)?.diagnostics ?? [];
            requireValue(Array.isArray(diagnostics) && diagnostics.length <= 16);
            calls.push({
              entryId: integer(found.entry.id),
              resultEntryId: id,
              byTaskId: integer(found.entry.byTaskId, 0),
              resultTaskId: integer(entry.byTaskId, 0),
              callId: String(found.call.id),
              name: found.call.name as SelectionCall["name"],
              arguments: found.call.arguments as Record<string, unknown>,
              result: { isError: m.isError, content, diagnostics },
              resultSha256: sha256(canonicalJson({ content, diagnostics, isError: m.isError })),
              resultTimestamp: integer(m.timestamp),
            });
            pending.delete(key);
          }
        }
      }
    }
    requireValue(pending.size === 0 && calls.length <= 4 && messages.length <= 2);
    return { agentId, conversationId, through, piEntryThrough, messages, calls, jobs, tasks };
  } catch {
    throw new Error(failure);
  }
}
export async function selectionExport(
  client: FortiPiClient,
  agentId: string,
  conversationId: string,
  secrets: readonly string[],
  requestId = randomUUID(),
) {
  const request = deviceReadRequests();
  let operation = await request(() =>
    client.operations.createExport({
      path: {},
      query: {},
      body: {
        requestId,
        resources: { ...selectionExportScope(agentId, conversationId), actions: [] },
        maxBytes: 1048576,
      },
    }),
  );
  const end = Date.now() + 120000;
  while (["pending", "running"].includes(operation.state) && Date.now() < end) {
    await new Promise<void>((accept) => setTimeout(accept, 250));
    operation = await request(() =>
      client.operations.getAdminOperation({
        path: { id: operation.operationId },
        query: {},
        body: undefined,
      }),
    );
  }
  requireValue(
    operation.kind === "export" &&
      operation.state === "completed" &&
      operation.artifacts.length === 1,
  );
  const artifact = operation.artifacts[0]!;
  requireValue(
    artifact.scope.kind === "agent" &&
      artifact.scope.agentId === agentId &&
      canonicalJson(artifact.scope.conversationIds) === canonicalJson([conversationId]),
  );
  requireValue(
    artifact.endpoint === `/v1/admin/artifacts/${artifact.artifactId}` &&
      artifact.size > 0 &&
      artifact.size <= 1048576,
  );
  const bytes = await request(() =>
    client.operations.getAdminArtifact({
      path: { id: artifact.artifactId },
      query: {},
      body: undefined,
    }),
  );
  requireValue(bytes.length === artifact.size && sha256(bytes) === artifact.sha256);
  return {
    operationId: operation.operationId,
    artifact: { ...artifact },
    transcript: parseSelectionExport(bytes, agentId, conversationId, secrets),
  };
}
export function selectionAttempt(
  transcript: SelectionTranscript,
  expected: {
    workspaceId: string;
    baseRevision: string;
    targets: NativeTarget[];
    ranked: string[];
    selected: NativeTarget;
    mode: "omitted" | "explicit";
    refusal?:
      | "Workspace base changed"
      | "No currently eligible configured target accepts these tool arguments";
  },
) {
  try {
    const contexts = transcript.calls.filter((call) => call.name === "fortipi_context"),
      dispatches = transcript.calls.filter((call) => call.name === "fortipi_dispatch");
    requireValue(contexts.length === 1 && dispatches.length === 1);
    const contextCall = contexts[0]!,
      dispatch = dispatches[0]!;
    const contextArgs = rawObject(
      contextCall.arguments,
      ["tool", "capabilities"],
      ["workspaceId", "target", "limit", "pageToken", "executorPageToken"],
    );
    requireValue(contextArgs.tool === "shell");
    strings(contextArgs.capabilities);
    if (Object.hasOwn(contextArgs, "workspaceId"))
      requireValue(text(contextArgs.workspaceId) === expected.workspaceId);
    if (Object.hasOwn(contextArgs, "target")) rawNativeTarget(contextArgs.target);
    if (Object.hasOwn(contextArgs, "limit")) requireValue(integer(contextArgs.limit) <= 100);
    for (const key of ["pageToken", "executorPageToken"])
      if (Object.hasOwn(contextArgs, key)) text(contextArgs[key], 1024);
    requireValue(
      contextCall.resultEntryId < dispatch.entryId && contextCall.result.isError === false,
    );
    const context = JSON.parse(
      contextCall.result.content.map((c) => c.text).join("\n"),
    ) as SelectionContext;
    rawObject(context, ["routing", "argumentContracts", "targets", "workspaces"]);
    requireValue(
      canonicalJson(context.routing) ===
        canonicalJson({ kind: "prefer-local", targetIds: expected.ranked }),
    );
    requireValue(
      typeof context.argumentContracts["native-shell"] === "string" &&
        context.argumentContracts["native-shell"].includes("command"),
    );
    requireValue(
      Array.isArray(context.targets) &&
        context.targets.length === 2 &&
        Array.isArray(context.workspaces) &&
        context.workspaces.length === 1,
    );
    requireValue(
      canonicalJson(
        context.targets
          .map((t) => rawNativeTarget(t.target))
          .sort((a, b) => (a.executorId < b.executorId ? -1 : 1)),
      ) ===
        canonicalJson([...expected.targets].sort((a, b) => (a.executorId < b.executorId ? -1 : 1))),
    );
    const workspace = context.workspaces[0]!;
    requireValue(
      workspace.configured === true &&
        workspace.provider === "computer" &&
        workspace.workspaceId === expected.workspaceId &&
        workspace.baseRevision === expected.baseRevision,
    );
    requireValue(
      expected.targets.every((target) =>
        workspace.targets.some((t) => canonicalJson(t) === canonicalJson(target)),
      ),
    );
    const args = rawNativeDispatch(dispatch.arguments);
    requireValue(
      args.workspaceId === expected.workspaceId && args.baseRevision === expected.baseRevision,
    );
    requireValue(
      expected.mode === "omitted"
        ? !Object.hasOwn(args, "target")
        : canonicalJson(args.target) === canonicalJson(expected.selected),
    );
    const native = context.targets.find(
      (t) => canonicalJson(t.target) === canonicalJson(expected.selected),
    );
    requireValue(
      native &&
        native.argumentFormat === "native-shell" &&
        native.platform === "linux" &&
        Array.isArray(native.capabilities),
    );
    requireValue(
      native.capabilities.includes("shell") &&
        args.capabilities.every((cap) => native.capabilities.includes(cap)),
    );
    if (expected.refusal) {
      requireValue(dispatch.result.isError === true);
      requireValue(
        dispatch.result.diagnostics.some((value) => {
          const d = value as { severity?: unknown; code?: unknown; message?: unknown };
          return d.code === "tool_error" && d.message === expected.refusal;
        }),
      );
      requireValue(
        dispatch.result.content.some((t) => t.text.includes(`[error] ${expected.refusal}`)) &&
          transcript.jobs.length === 0,
      );
    } else requireValue(dispatch.result.isError === false && transcript.jobs.length === 1);
    // Context and dispatch are the ONLY tool records retained. No analysis text.
    return {
      context: contextCall,
      dispatch: expected.refusal
        ? dispatch
        : { ...dispatch, result: { ...dispatch.result, content: [], diagnostics: [] } },
      arguments: args,
    };
  } catch {
    throw new Error(failure);
  }
}
