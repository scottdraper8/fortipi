import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readBounded } from "../../packages/fortipi-client/dist/http.js";
import { Validation } from "../../packages/fortipi-client/dist/validation.js";
import type {
  CredentialMint,
  CredentialReceipt,
  ErrorBody,
  OperationId,
  OperationRequest,
  OperationValue,
  RevocationReceipt,
} from "../../packages/fortipi-contract/dist/index.js";
import { routeCatalog, wireLimits } from "../../packages/fortipi-contract/dist/index.js";

const receiptValidation = new Validation();

export type IssuedRole = Extract<CredentialReceipt, { state: "issued" }>;
export interface CleanupObservation {
  credentialId: string;
  generation: number;
  state: "complete" | "pending" | "unknown";
  pendingRecipients: number | null;
}
const cleanupCategories = [
  "http-non-ok",
  "json-read-failure",
  "invalid-receipt",
  "pending",
  "unknown",
] as const;
export interface CleanupDiagnostic {
  category: (typeof cleanupCategories)[number];
  status: number | null;
  pendingRecipients: number | null;
}
export function projectCleanupDiagnostic(value: unknown): CleanupDiagnostic | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(fields);
    if (
      keys.length !== 3 ||
      !["category", "status", "pendingRecipients"].every(
        (key) => Object.hasOwn(fields, key) && Object.hasOwn(fields[key] ?? {}, "value"),
      )
    )
      return null;
    const category: unknown = fields.category?.value;
    const status: unknown = fields.status?.value;
    const pendingRecipients: unknown = fields.pendingRecipients?.value;
    if (
      !cleanupCategories.some((known) => known === category) ||
      (status !== null &&
        !(
          typeof status === "number" &&
          Number.isSafeInteger(status) &&
          status >= 100 &&
          status <= 599
        )) ||
      (pendingRecipients !== null &&
        !(
          typeof pendingRecipients === "number" &&
          Number.isSafeInteger(pendingRecipients) &&
          pendingRecipients >= 0 &&
          pendingRecipients <= 100
        ))
    )
      return null;
    return { category, status, pendingRecipients } as CleanupDiagnostic;
  } catch {
    return null;
  }
}
class CleanupFailure extends Error {
  readonly category: "http-non-ok" | "json-read-failure" | "invalid-receipt";
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  constructor(
    category: "http-non-ok" | "json-read-failure" | "invalid-receipt",
    status: number,
    retryAfterMs?: number,
  ) {
    super("Trusted coordinator cleanup response failed");
    this.category = category;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
function rateLimitWait(response: Response, value: unknown): number | undefined {
  receiptValidation.assert("ErrorBody", value);
  const { error } = value as ErrorBody;
  const delay = error.details?.retryAfterMs;
  if (
    error.code !== "rate_limited" ||
    error.retryable !== true ||
    !Number.isSafeInteger(delay) ||
    delay === undefined ||
    delay <= 0 ||
    delay > 86400000 ||
    // Other action/capability/continuation instructions are not supported here.
    Object.keys(error.details ?? {}).length !== 1
  )
    return undefined;
  const header = response.headers.get("retry-after");
  if (header === null) return delay;
  // Support delta-seconds only. Dates and combined/duplicate values are ambiguous.
  if (!/^\d+$/.test(header)) return undefined;
  const headerMs = Number(header) * 1000;
  if (!Number.isSafeInteger(headerMs) || headerMs > 86400000) return undefined;
  return Math.max(delay, headerMs);
}
/** Trusted coordinator only. Never pass this object/admin to a client child. */
export class RoleContext {
  readonly #endpoint: string;
  readonly #admin: string;
  readonly #roles: {
    readonly receipt: IssuedRole;
    readonly revokeRequestId: string;
    completed?: Extract<RevocationReceipt, { state: "complete" }>;
  }[] = [];
  constructor(endpoint: string, admin: string) {
    const url = new URL(endpoint);
    assert.ok(
      url.protocol === "https:" ||
        (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)),
    );
    assert.equal(url.origin, endpoint);
    assert.ok(!url.username && !url.password);
    assert.ok(admin.length >= 32);
    this.#admin = admin;
    this.#endpoint = endpoint;
  }
  get endpoint(): string {
    return this.#endpoint;
  }
  async call<K extends OperationId>(
    input: OperationRequest<K>,
    deadline = Date.now() + 30000,
  ): Promise<OperationValue<K>> {
    const route = routeCatalog.find((r) => r.operationId === input.operationId);
    assert.ok(route);
    const path = route.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
      const value = (input.path as Record<string, string>)[key];
      assert.ok(value);
      return encodeURIComponent(value);
    });
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input.query))
      if (value !== undefined) query.set(key, String(value));
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const remaining = deadline - Date.now();
    assert.ok(Number.isSafeInteger(deadline) && remaining > 0, "Coordinator deadline expired");
    const signal = AbortSignal.timeout(Math.min(30000, remaining));
    const response = await fetch(`${this.#endpoint}${path}${query.size ? `?${query}` : ""}`, {
      method: route.method,
      redirect: "error",
      signal,
      headers: { Authorization: `Bearer ${this.#admin}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok && input.operationId === "revokeCredential") {
      let retryAfterMs: number | undefined;
      if (response.status === 429) {
        try {
          const bytes = await readBounded(response, wireLimits.jsonBytes, signal);
          retryAfterMs = rateLimitWait(
            response,
            JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)),
          );
        } catch {
          /* An unreadable or invalid refusal never authorizes another send. */
        }
      } else void response.body?.cancel().catch(() => {});
      throw new CleanupFailure("http-non-ok", response.status, retryAfterMs);
    }
    assert.ok(
      response.ok,
      `Trusted public coordinator operation failed: ${input.operationId} (${response.status})`,
    );
    let value: unknown;
    try {
      value =
        input.operationId === "revokeCredential"
          ? JSON.parse(
              new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
                await readBounded(response, wireLimits.jsonBytes, signal),
              ),
            )
          : await response.json();
    } catch (error) {
      if (input.operationId === "revokeCredential")
        throw new CleanupFailure("json-read-failure", response.status);
      throw error;
    }
    signal.throwIfAborted();
    assert.ok(Date.now() < deadline, "Coordinator deadline expired");
    if (input.operationId === "revokeCredential") {
      try {
        assert.ok(response.status === 200 || response.status === 202);
        receiptValidation.assert(
          response.status === 200 ? "RevocationComplete" : "RevocationPending",
          value,
        );
      } catch {
        throw new CleanupFailure("invalid-receipt", response.status);
      }
    }
    return value as OperationValue<K>;
  }
  async issue(input: CredentialMint): Promise<IssuedRole> {
    const result = await this.call({
      operationId: "mintCredential",
      path: {},
      query: {},
      body: input,
    });
    assert.equal(result.state, "issued");
    if (result.state !== "issued") throw new Error("Ephemeral role token was not issued");
    this.#roles.push({ receipt: structuredClone(result), revokeRequestId: randomUUID() });
    return result;
  }
  async issueBrowserRevocation(agentId: string, conversationId: string): Promise<IssuedRole> {
    assert.ok(
      typeof agentId === "string" &&
        agentId.length > 0 &&
        agentId !== "*" &&
        typeof conversationId === "string" &&
        conversationId.length > 0 &&
        conversationId !== "*",
      "Browser revocation requires one concrete agent and conversation",
    );
    return this.issue({
      requestId: randomUUID(),
      role: "client",
      expiresAt: Date.now() + 900000,
      grants: [
        {
          grantId: randomUUID(),
          version: 1,
          resources: {
            agentIds: [agentId],
            conversationIds: [conversationId],
            workspaceIds: [],
            executorIds: [],
            backendIds: [],
            tools: [],
            actions: ["conversations.read", "events.read", "tickets.mint"],
          },
        },
      ],
    });
  }
  assertSanitized(value: unknown, suppliedTokens: readonly string[] = []) {
    const bytes = JSON.stringify(value);
    for (const token of [
      this.#admin,
      ...this.#roles.map((r) => r.receipt.token),
      ...suppliedTokens,
    ])
      assert.ok(
        !bytes.includes(token) && !bytes.includes(JSON.stringify(token).slice(1, -1)),
        "Credential appeared in evidence",
      );
  }
  async revoke(credentialId: string, deadline = Date.now() + 30000): Promise<RevocationReceipt> {
    const role = this.#roles.find((r) => r.receipt.credential.credentialId === credentialId);
    assert.ok(role, "Only coordinator-issued ephemeral roles may be revoked here");
    // Reuse this tuple's terminal receipt; this is not a fresh server observation.
    if (role.completed) return structuredClone(role.completed);
    const input = {
      operationId: "revokeCredential",
      path: { id: credentialId },
      query: {},
      body: {
        requestId: role.revokeRequestId,
        expectedGeneration: role.receipt.credential.generation,
      },
    } as const;
    while (true) {
      try {
        const receipt = await this.call(input, deadline);
        if (receipt.state === "complete") role.completed = structuredClone(receipt);
        return receipt;
      } catch (error) {
        if (
          !(error instanceof CleanupFailure) ||
          error.status !== 429 ||
          error.retryAfterMs === undefined ||
          error.retryAfterMs >= deadline - Date.now()
        )
          throw error;
        await new Promise<void>((accept) => setTimeout(accept, error.retryAfterMs));
        if (Date.now() >= deadline) throw error;
      }
    }
  }
  async revokeAndWait(
    credentialId: string,
    deadline = Date.now() + 15000,
  ): Promise<RevocationReceipt> {
    let receipt = await this.revoke(credentialId, deadline);
    while (receipt.state !== "complete" && deadline - Date.now() > 100) {
      await new Promise<void>((accept) => setTimeout(accept, 100));
      if (Date.now() >= deadline) break;
      receipt = await this.revoke(credentialId, deadline);
    }
    return receipt;
  }
  async cleanup(observer?: (diagnostic: CleanupDiagnostic) => void): Promise<CleanupObservation[]> {
    const deadline = Date.now() + 90000;
    const observations: CleanupObservation[] = [];
    const observe = (diagnostic: CleanupDiagnostic) => {
      try {
        observer?.(diagnostic);
      } catch {
        /* Diagnostics cannot interrupt cleanup. */
      }
    };
    for (const { receipt } of this.#roles) {
      let result: RevocationReceipt | undefined;
      try {
        result = await this.revokeAndWait(receipt.credential.credentialId, deadline);
      } catch (error) {
        /* Preserve uncertainty in the cleanup row; it blocks acceptance. */
        let diagnostic: CleanupDiagnostic = {
          category: "unknown",
          status: null,
          pendingRecipients: null,
        };
        try {
          if (error instanceof CleanupFailure)
            diagnostic =
              projectCleanupDiagnostic({
                category: Object.getOwnPropertyDescriptor(error, "category")?.value,
                status: Object.getOwnPropertyDescriptor(error, "status")?.value,
                pendingRecipients: null,
              }) ?? diagnostic;
        } catch {
          /* Unknown exceptions remain unclassified. */
        }
        observe(diagnostic);
      }
      if (result?.state === "pending")
        observe({
          category: "pending",
          status: null,
          pendingRecipients: result.pendingRecipients.length,
        });
      observations.push({
        credentialId: receipt.credential.credentialId,
        generation: receipt.credential.generation,
        state: result?.state ?? "unknown",
        pendingRecipients: result?.pendingRecipients.length ?? null,
      });
    }
    this.assertSanitized(observations);
    return observations;
  }
}
export function roleEnvironment(token: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    FORTIPI_CLIENT_TOKEN: token,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}
