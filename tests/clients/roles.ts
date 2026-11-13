import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  CredentialMint,
  CredentialReceipt,
  OperationId,
  OperationRequest,
  OperationValue,
  RevocationReceipt,
} from "../../packages/fortipi-contract/dist/index.js";
import { routeCatalog } from "../../packages/fortipi-contract/dist/index.js";

export type IssuedRole = Extract<CredentialReceipt, { state: "issued" }>;
export interface CleanupObservation {
  credentialId: string;
  generation: number;
  state: "complete" | "pending" | "unknown";
  pendingRecipients: number | null;
}
/** Trusted coordinator only. Never pass this object/admin to a client child. */
export class RoleContext {
  readonly endpoint: string;
  readonly #admin: string;
  readonly #roles: { receipt: IssuedRole; revokeRequestId: string }[] = [];
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
    this.endpoint = endpoint;
  }
  async call<K extends OperationId>(input: OperationRequest<K>): Promise<OperationValue<K>> {
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
    const response = await fetch(`${this.endpoint}${path}${query.size ? `?${query}` : ""}`, {
      method: route.method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${this.#admin}`, "Content-Type": "application/json" },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    assert.ok(
      response.ok,
      `Trusted public coordinator operation failed: ${input.operationId} (${response.status})`,
    );
    return (await response.json()) as OperationValue<K>;
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
    this.#roles.push({ receipt: result, revokeRequestId: randomUUID() });
    return result;
  }
  assertSanitized(value: unknown) {
    const bytes = JSON.stringify(value);
    for (const token of [this.#admin, ...this.#roles.map((r) => r.receipt.token)])
      assert.ok(
        !bytes.includes(token) && !bytes.includes(JSON.stringify(token).slice(1, -1)),
        "Credential appeared in evidence",
      );
  }
  revoke(credentialId: string): Promise<RevocationReceipt> {
    const role = this.#roles.find((r) => r.receipt.credential.credentialId === credentialId);
    assert.ok(role, "Only coordinator-issued ephemeral roles may be revoked here");
    return this.call({
      operationId: "revokeCredential",
      path: { id: credentialId },
      query: {},
      body: {
        requestId: role.revokeRequestId,
        expectedGeneration: role.receipt.credential.generation,
      },
    });
  }
  async revokeAndWait(credentialId: string): Promise<RevocationReceipt> {
    const deadline = Date.now() + 15000;
    let receipt = await this.revoke(credentialId);
    while (receipt.state !== "complete" && Date.now() < deadline) {
      await new Promise<void>((accept) => setTimeout(accept, 100));
      receipt = await this.revoke(credentialId);
    }
    return receipt;
  }
  async cleanup(): Promise<CleanupObservation[]> {
    const observations: CleanupObservation[] = [];
    for (const { receipt } of this.#roles) {
      let result: RevocationReceipt | undefined;
      try {
        result = await this.revokeAndWait(receipt.credential.credentialId);
      } catch {
        /* Preserve uncertainty in the cleanup row; it blocks acceptance. */
      }
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
