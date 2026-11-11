import type { AnySchema, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  ClientAck,
  ClientError,
  ClientEvent,
  Manifest,
  ProviderAuthPut,
  ResyncRequired,
  RouteDefinition,
} from "fortipi-contract";
import {
  routeCatalog,
  schemaRefs,
  schemaRegistry,
  validateManifest,
  validateProviderAuthPut,
  validateRelativePath,
} from "fortipi-contract";
import { FortiPiError } from "./errors.js";

export type ServerFrame = ClientEvent | ClientAck | ClientError | ResyncRequired;
/** Each client owns one fixed registry. Remote schemas are data, never compiled. */
export class Validation {
  private readonly ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
  private readonly fixed = new Map<string, ValidateFunction>();
  constructor() {
    for (const schema of Object.values(schemaRegistry)) this.ajv.addSchema(schema as AnySchema);
    const names = new Set<string>([
      "ClientEvent",
      "ClientAck",
      "ClientError",
      "ResyncRequired",
      "ClientCommand",
      "ErrorBody",
      "ByteReference",
      "Protocol",
      "TicketIdentity",
    ]);
    for (const route of routeCatalog) {
      if ("successSchemas" in route)
        for (const name of Object.values(route.successSchemas)) names.add(name);
      for (const name of [route.query, route.body, route.response]) if (name) names.add(name);
    }
    for (const name of names)
      this.fixed.set(name, this.ajv.compile({ $ref: schemaRefs[name as keyof typeof schemaRefs] }));
  }
  assert(name: string, value: unknown): void {
    const validate = this.fixed.get(name);
    if (!validate?.(value)) throw new FortiPiError("invalid_wire");
  }
  frame(value: unknown): ServerFrame {
    if (!value || typeof value !== "object") throw new FortiPiError("invalid_wire");
    const type = (value as { type?: unknown }).type;
    this.assert(
      type === "ack"
        ? "ClientAck"
        : type === "error"
          ? "ClientError"
          : type === "resync_required"
            ? "ResyncRequired"
            : "ClientEvent",
      value,
    );
    return value as ServerFrame;
  }
  request(route: RouteDefinition, input: { path: unknown; query: unknown; body: unknown }): void {
    if (!input.path || typeof input.path !== "object" || Array.isArray(input.path))
      throw new FortiPiError("invalid_request");
    const path = input.path as Record<string, unknown>;
    const fields = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
    if (Object.keys(path).length !== fields.length) throw new FortiPiError("invalid_request");
    for (const field of fields) {
      const value = path[field];
      if (
        field === "chunkIndex"
          ? !Number.isSafeInteger(value) || Number(value) < 0
          : typeof value !== "string" || (!/^[A-Za-z0-9_-]{1,128}$/.test(value) && field !== "name")
      )
        throw new FortiPiError("invalid_request");
      if (field === "sha256" && !/^[a-f0-9]{64}$/.test(String(value)))
        throw new FortiPiError("invalid_request");
      if (field === "name" && !Object.hasOwn(schemaRegistry, String(value)))
        throw new FortiPiError("invalid_request");
    }
    this.assert(route.query, input.query);
    if (route.body) this.assert(route.body, input.body);
    else if (route.method === "PUT" && route.transport === "bytes") {
      if (!(input.body instanceof Uint8Array)) throw new FortiPiError("invalid_request");
    } else if (input.body !== undefined) throw new FortiPiError("invalid_request");
    try {
      if (route.operationId === "putProviderAuth")
        validateProviderAuthPut(input.body as ProviderAuthPut);
      if (route.owner === "workspace") {
        const query = input.query as { path?: string };
        if (query.path !== undefined) validateRelativePath(query.path);
        if (route.operationId === "beginUpload" || route.operationId === "transactWorkspace") {
          const body = input.body as { manifest?: Manifest; mutations: { path: string }[] };
          if (body.manifest) validateManifest(body.manifest);
          for (const mutation of body.mutations) validateRelativePath(mutation.path);
        }
      }
    } catch {
      throw new FortiPiError(
        route.operationId === "putProviderAuth" ? "payload_too_large" : "invalid_request",
      );
    }
  }
}
