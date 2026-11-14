import type * as D from "../boundary/dto.js";

/** Existing daemon checkPolicy and Computer ExecutionLedger.exec payloads; no alternate executor API. */
export const argumentContracts = {
  "native-shell":
    'tool="shell", arguments={"command": string}. Use the executor platform shell syntax, with cwd at the scoped workspace. Command must contain no NUL and be at most65536 UTF-8 bytes. Remote approval and independent local consent remain required.',
  "javascript-module":
    'tool="javascript", arguments={"source": string, "input"?: JSON}. Source is a JavaScript ES module with a default exported function, e.g. export default async function () { return 42; }. Files are under /workspace; node:fs/promises is supported. Source is at most65536 UTF-8 bytes; no shell or network is implied.',
  "cloud-shell":
    'tool="shell", arguments={"source": string, "input"?: JSON}. Source is Linux shell text executed in /workspace by the selected container runtime, at most65536 UTF-8 bytes. Use source rather than native command for this target.',
} as const;

export function acceptsArguments(
  format: keyof typeof argumentContracts,
  args: D.JsonObject,
): boolean {
  const source = format === "native-shell" ? args.command : args.source;
  return (
    typeof source === "string" &&
    new TextEncoder().encode(source).length <= 65536 &&
    (format !== "native-shell" || !source.includes("\0"))
  );
}

/** Workspace capability names are not executable operation identities. */
export function backendSupportsTool(kind: "cloud-js" | "linux", tool: string): boolean {
  return tool === (kind === "cloud-js" ? "javascript" : "shell");
}
