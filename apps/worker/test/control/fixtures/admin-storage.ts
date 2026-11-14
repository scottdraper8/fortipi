import { DurableObject } from "cloudflare:workers";
import { freeInfrastructurePolicy } from "fortipi-contract";
import type { Env } from "../../../src/boundary/env.js";
import { AdminChunks } from "../../../src/control/admin.js";
import { Capacity } from "../../../src/control/capacity.js";
import { Directory } from "../../../src/control/directory.js";
import { Identities } from "../../../src/control/identity.js";
import { ControlError, check, outcome, Store } from "../../../src/control/store.js";

/** Storage primitive fixture only; it makes no admin/peer export authorization claim. */
export class AdminStorageFixture extends DurableObject<Env> {
  readonly #chunks: AdminChunks;
  readonly #store: Store;
  readonly #identities: Identities;
  readonly #capacity: Capacity;
  readonly #token = crypto.randomUUID() + crypto.randomUUID();
  readonly #initialized: Promise<void>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new Store(ctx.storage);
    this.#identities = new Identities(this.#store, ctx.id.toString());
    const directory = new Directory(this.#store, this.#identities, env);
    this.#capacity = new Capacity(this.#store, this.#identities, directory);
    this.#chunks = new AdminChunks(this.#store, () => directory.policy().bounds, this.#capacity);
    this.#initialized = ctx.blockConcurrencyWhile(() => this.#identities.bootstrap(this.#token));
  }
  async nearFullReservation(): Promise<string> {
    await this.#initialized;
    const ctx = await this.#identities.authenticate({
      bearer: this.#token,
      deploymentId: this.ctx.id.toString(),
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 30000,
    });
    const limit = Math.floor(
      freeInfrastructurePolicy.bounds.installBytes *
        (1 - freeInfrastructurePolicy.bounds.headroomFraction),
    );
    const reservation = this.#capacity.reserve(ctx, {
      operationId: "existing-pending-work",
      ownerId: "pending-owner",
      policyVersion: freeInfrastructurePolicy.version,
      bytes: limit - this.#capacity.directory.budget.usage().total - 16384,
      admissionSlots: 0,
    });
    return JSON.stringify({
      reservation,
      usage: this.#capacity.usage(),
      physical: this.ctx.storage.sql.databaseSize,
    });
  }
  async usage(): Promise<string> {
    return JSON.stringify({
      usage: this.#capacity.usage(),
      physical: this.ctx.storage.sql.databaseSize,
      ready: this.ctx.storage.sql
        .exec<{ n: number }>("SELECT count(*) n FROM cp_records WHERE kind='admin_artifact'")
        .one().n,
    });
  }
  async put(artifactId: string, ordinal: number, bytes: Uint8Array): Promise<string> {
    return JSON.stringify(
      await outcome("storage-fixture", async () => {
        this.#chunks.append(artifactId, ordinal, bytes);
        return true;
      }),
    );
  }
  async verify(artifactId: string, size: number, sha256: string): Promise<string> {
    return JSON.stringify(
      await outcome(
        "storage-fixture",
        async () => this.#chunks.verify(artifactId, size, sha256, () => {}).sha256,
      ),
    );
  }
  async audit(): Promise<string> {
    const row = this.ctx.storage.sql
      .exec<{ rows: number; bytes: number; blobRows: number }>(
        "SELECT count(*) rows,COALESCE(SUM(length(data)),0) bytes,COALESCE(SUM(typeof(data)='blob'),0) blobRows FROM cp_admin_chunks",
      )
      .one();
    return JSON.stringify({
      ...row,
      jsonRows: this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM cp_records").one()
        .n,
    });
  }
  async tamper(artifactId: string, ordinal: number, bytes: Uint8Array): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE cp_admin_chunks SET data=? WHERE artifact_id=? AND ordinal=?",
      new Uint8Array(bytes).buffer,
      artifactId,
      ordinal,
    );
  }
  async remove(artifactId: string): Promise<void> {
    this.#chunks.remove(artifactId);
  }
  async streamingGuard(revoke: boolean): Promise<string> {
    await this.#initialized;
    const ctx = await this.#identities.authenticate({
      bearer: this.#token,
      deploymentId: this.ctx.id.toString(),
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 30000,
    });
    let checks = 0;
    const stream = this.#chunks.stream(
        "artifact",
        131072,
        () => {
          checks++;
          this.#identities.current(ctx);
        },
        new AbortController().signal,
      ),
      reader = stream.getReader();
    const initial = checks,
      first = await reader.read(),
      afterFirst = checks;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const idle = checks;
    if (!revoke) {
      await reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return JSON.stringify({
        initial,
        first: first.value?.length,
        afterFirst,
        idle,
        afterCancel: checks,
      });
    }
    const credential = this.#store.get<{ generation: number }>("credential", ctx.credentialId);
    check(credential, "not_found", "Fixture credential missing");
    this.#store.put("credential", ctx.credentialId, {
      ...credential,
      generation: credential.generation + 1,
    });
    let code = "accepted";
    try {
      await reader.read();
    } catch (error) {
      code = error instanceof ControlError ? error.code : "unexpected";
    }
    return JSON.stringify({
      initial,
      first: first.value?.length,
      afterFirst,
      idle,
      code,
      afterRevoke: checks,
    });
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url),
      id = url.searchParams.get("id") ?? "artifact",
      size = Number(url.searchParams.get("size")),
      sha256 = url.searchParams.get("sha256") ?? "";
    const raw = request.headers.get("Range"),
      match = raw === null ? null : /^bytes=(\d+)-(\d+)$/.exec(raw);
    if (raw !== null && !match) return new Response(null, { status: 416 });
    const range = match ? { start: Number(match[1]), end: Number(match[2]) } : undefined;
    const observed = this.#chunks.verify(id, size, sha256, () => {}, range),
      selectedSize = range ? range.end - range.start + 1 : size;
    const body = this.#chunks
      .stream(id, size, () => {}, request.signal, range)
      .pipeThrough(new FixedLengthStream(selectedSize));
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(selectedSize),
      "X-Content-SHA256": observed.selectedSha256,
    });
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    return new Response(body, { status: range ? 206 : 200, headers });
  }
}
export default {
  fetch(request: Request, env: { CONTROL_PLANE: DurableObjectNamespace<AdminStorageFixture> }) {
    return env.CONTROL_PLANE.getByName("control").fetch(request);
  },
};
