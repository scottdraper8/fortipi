import Ajv from "ajv/dist/2020.js";
import { schemaRegistry } from "fortipi-contract";
import { check, ServiceError } from "./common.js";

// Only pinned, local schemas. Compilation is confined to module activation.
const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
for (const schema of Object.values(schemaRegistry)) {
  for (const name of Object.keys(schema.$defs)) {
    const ref = `${schema.$id}#/$defs/${name}`;
    if (!validators.has(name)) validators.set(name, ajv.compile({ $ref: ref }));
  }
}
export function valid<T>(name: string, value: unknown): value is T {
  return validators.get(name)?.(value) === true;
}
export function validate<T>(name: string, value: unknown): asserts value is T {
  check(valid<T>(name, value), "invalid_request", "Invalid request shape");
}
export async function boundedBody(
  request: Pick<Request, "body" | "signal">,
  limit = 262144,
  deadline = Date.now() + 30000,
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  check(reader, "invalid_request", "Request body required");
  let size = 0;
  const parts: Uint8Array[] = [];
  let onAbort: (() => void) | undefined;
  const timer = new AbortController();
  const signal = AbortSignal.any([request.signal, timer.signal]);
  const timeout = setTimeout(() => timer.abort(), Math.max(1, deadline - Date.now()));
  try {
    signal.throwIfAborted();
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(new ServiceError("interrupted", "Request body cancelled or its deadline expired"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    while (true) {
      signal.throwIfAborted();
      check(Date.now() < deadline, "interrupted", "Request body deadline expired");
      const part = await Promise.race([reader.read(), interrupted]);
      if (part.done) break;
      size += part.value.byteLength;
      check(size <= limit, "payload_too_large", "Body exceeds limit");
      parts.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
export async function boundedJson(
  request: Pick<Request, "body" | "signal">,
  limit = 262144,
  deadline = Date.now() + 30000,
): Promise<unknown> {
  const bytes = await boundedBody(request, limit, deadline);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch {
    check(false, "invalid_request", "Invalid JSON");
  }
}
