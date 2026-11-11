import type { CreateModelsOptions } from "@earendil-works/pi-ai/models";
import type * as D from "../boundary/dto.js";
import { type OAuthCredential, validateCredential } from "./provider-oauth.js";
import { check, hash, json, next, type Store, same } from "./store.js";

type CredentialStore = NonNullable<CreateModelsOptions["credentials"]>;
type Credential = Awaited<ReturnType<CredentialStore["read"]>>;
type Options = Parameters<CredentialStore["read"]>[1];
type Row = {
  provider: string;
  version: number;
  generation: number;
  state: D.ProviderAuthReceipt["state"];
  updated: number;
  nonce: string | null;
  ciphertext: string | null;
  key_id: string | null;
};
const b64 = (v: Uint8Array): string => btoa(String.fromCharCode(...v));
const un64 = (v: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(v), (x) => x.charCodeAt(0));
export class EncryptedCredentialStore implements CredentialStore {
  readonly store: Store;
  readonly deploymentId: string;
  readonly material: string | undefined;
  private chains = new Map<string, Promise<unknown>>();
  private refreshing = new Set<string>();
  private encryptionKey?: Promise<{ key: CryptoKey; keyId: string }>;
  constructor(store: Store, deploymentId: string, material?: string) {
    this.store = store;
    this.deploymentId = deploymentId;
    this.material = material;
    store.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS cp_provider_auth(provider TEXT PRIMARY KEY,version INTEGER NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL,nonce TEXT,ciphertext TEXT,key_id TEXT)`,
    );
  }
  private key(): Promise<{ key: CryptoKey; keyId: string }> {
    if (!this.encryptionKey)
      this.encryptionKey = (async () => {
        check(
          this.material,
          "unsupported",
          "Configure dedicated FORTIPI_MODEL_AUTH_KEY for OAuth",
          {
            requiredCapability: "model-auth-key",
            setup:
              "Use the management CLI to provision or preserve the independent model authentication key",
          },
        );
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          bytes = /^[a-f0-9]{64}$/i.test(this.material)
            ? Uint8Array.from(this.material.match(/../g) ?? [], (x) => Number.parseInt(x, 16))
            : un64(this.material);
        } catch {
          throw new Error("Invalid model authentication key");
        }
        check(bytes.length === 32, "unsupported", "Model authentication key must be 256 bits");
        return {
          key: await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
            "encrypt",
            "decrypt",
          ]),
          keyId: (await hash(bytes)).slice(0, 32),
        };
      })();
    return this.encryptionKey;
  }
  private row(provider: string): Row | undefined {
    return this.store.storage.sql
      .exec<Row>("SELECT * FROM cp_provider_auth WHERE provider=?", provider)
      .toArray()[0];
  }
  status(provider: string): D.ProviderAuthStatus {
    const r = this.row(provider);
    const orphan = !!this.store.get("provider_refresh", provider) && !this.refreshing.has(provider);
    return {
      providerId: provider,
      version: r?.version ?? null,
      generation: r?.generation ?? 0,
      state: orphan ? "reauth_required" : (r?.state ?? "absent"),
      ...(r ? { updatedAt: r.updated } : {}),
    };
  }
  private aad(
    provider: string,
    version: number,
    generation: number,
    keyId: string,
  ): Uint8Array<ArrayBuffer> {
    return new Uint8Array(
      new TextEncoder().encode(
        json({ deployment: this.deploymentId, provider, format: 1, version, generation, keyId }),
      ),
    );
  }
  private async readUnlocked(provider: string): Promise<Credential> {
    check(
      this.status(provider).state !== "reauth_required",
      "unauthenticated",
      "An uncertain refresh requires sign in",
    );
    const r = this.row(provider);
    if (!r?.ciphertext || !r.nonce) return undefined;
    const { key, keyId } = await this.key();
    check(r.key_id === keyId, "unauthenticated", "Model key does not match encrypted credential");
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: un64(r.nonce),
        additionalData: this.aad(provider, r.version, r.generation, keyId),
      },
      key,
      un64(r.ciphertext),
    );
    const credential = JSON.parse(new TextDecoder().decode(bytes)) as OAuthCredential;
    validateCredential(provider, credential);
    return credential;
  }
  beginRefresh(provider: string): void {
    check(
      !this.store.get("provider_refresh", provider),
      "unauthenticated",
      "An uncertain refresh requires sign in",
    );
    this.store.put("provider_refresh", provider, {
      version: this.status(provider).version,
      generation: this.status(provider).generation,
    });
    this.refreshing.add(provider);
  }
  private enqueue<T>(provider: string, fn: () => Promise<T>, options?: Options): Promise<T> {
    const previous = this.chains.get(provider) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => {
        options?.signal?.throwIfAborted();
        return fn();
      });
    this.chains.set(provider, task);
    void task
      .finally(() => {
        if (this.chains.get(provider) === task) this.chains.delete(provider);
      })
      .catch(() => undefined);
    return task;
  }
  async read(provider: string, options?: Options): Promise<Credential> {
    return this.enqueue(provider, () => this.readUnlocked(provider), options);
  }
  async list(options?: Options): Promise<Awaited<ReturnType<CredentialStore["list"]>>> {
    options?.signal?.throwIfAborted();
    return this.store.storage.sql
      .exec<{ provider: string }>(
        "SELECT provider FROM cp_provider_auth WHERE ciphertext IS NOT NULL ORDER BY provider LIMIT 32",
      )
      .toArray()
      .map((r) => ({ providerId: r.provider, type: "oauth" as const }));
  }
  private async persist(
    provider: string,
    credential: OAuthCredential | undefined,
    before: D.ProviderAuthStatus,
    management: boolean,
    publish?: () => void,
  ): Promise<void> {
    const version = next(before.version ?? 0);
    const generation = management ? next(before.generation) : before.generation;
    const imported = await this.key();
    const existing = this.row(provider);
    check(
      !existing?.key_id || existing.key_id === imported.keyId,
      "unauthenticated",
      "Model key does not match encrypted credential",
    );
    let nonce: string | null = null;
    let ciphertext: string | null = null;
    let keyId: string | null = null;
    if (credential) {
      validateCredential(provider, credential);
      keyId = imported.keyId;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      nonce = b64(iv);
      ciphertext = b64(
        new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: this.aad(provider, version, generation, keyId) },
            imported.key,
            new TextEncoder().encode(json(credential)),
          ),
        ),
      );
    }
    this.store.tx(() => {
      const current = this.status(provider);
      check(
        current.version === before.version && current.generation === before.generation,
        "conflict",
        "Credential changed during refresh",
      );
      this.store.storage.sql.exec(
        `INSERT INTO cp_provider_auth VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET version=excluded.version,generation=excluded.generation,state=excluded.state,updated=excluded.updated,nonce=excluded.nonce,ciphertext=excluded.ciphertext,key_id=excluded.key_id`,
        provider,
        version,
        generation,
        credential ? "configured" : "absent",
        Date.now(),
        nonce,
        ciphertext,
        keyId,
      );
      this.store.remove("provider_refresh", provider);
      this.refreshing.delete(provider);
      publish?.();
    });
  }
  async modify(
    provider: string,
    fn: Parameters<CredentialStore["modify"]>[1],
    options?: Options,
  ): Promise<Credential> {
    return this.enqueue(
      provider,
      async () => {
        const before = this.status(provider);
        const current = await this.readUnlocked(provider);
        try {
          const updated = await fn(current);
          if (updated !== undefined) {
            check(updated.type === "oauth", "unsupported", "Encrypted store accepts OAuth only");
            if (!same(updated, current)) await this.persist(provider, updated, before, false);
            return updated;
          }
          return current;
        } finally {
          this.refreshing.delete(provider);
        }
      },
      options,
    );
  }
  async delete(provider: string, options?: Options): Promise<void> {
    return this.enqueue(
      provider,
      async () => this.persist(provider, undefined, this.status(provider), true),
      options,
    );
  }
  async manage(
    principal: string,
    provider: string,
    input: D.ProviderAuthPut | D.ProviderAuthDelete,
    credential?: OAuthCredential,
    guard?: () => void,
  ): Promise<D.ProviderAuthReceipt> {
    const digest = await hash(json(input));
    return this.enqueue(provider, async () => {
      guard?.();
      const key = `${principal}:${provider}:${input.requestId}`;
      const previous = this.store.get<{ digest: string; receipt: D.ProviderAuthReceipt }>(
        "provider_request",
        key,
      );
      if (previous) {
        check(previous.digest === digest, "conflict", "Authentication request changed");
        return previous.receipt;
      }
      const before = this.status(provider);
      check(before.version === input.expectedVersion, "conflict", "Authentication version changed");
      const imported = await this.key();
      const existing = this.row(provider);
      check(
        !existing?.key_id || existing.key_id === imported.keyId,
        "unauthenticated",
        "Model key does not match encrypted credential",
      );
      // Encryption awaits before a single transaction publishes ciphertext AND idempotent receipt.
      // The provider chain serializes refresh/ingest/logout for this object.
      const receipt: D.ProviderAuthReceipt = {
        providerId: provider,
        version: next(before.version ?? 0),
        generation: next(before.generation),
        state: credential ? "configured" : "absent",
      };
      await this.persist(provider, credential, before, true, () => {
        guard?.();
        this.store.put("provider_request", key, { digest, receipt });
      });
      return receipt;
    });
  }
}
