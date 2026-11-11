import { createHash } from "node:crypto";
import { canonicalJson, digestJson, incrementSafe, wireLimits } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type {
  StorageSampleInput,
  WorkspaceStorageSample,
  WorkspaceStorageSampleInput,
} from "../boundary/infrastructure.js";
import {
  type AllocationRecord,
  authorize,
  authorizeReservedAction,
  permitsResource,
  same,
} from "./authority.js";
import { requireThat } from "./errors.js";
import { internalHeader, type WorkspaceObject } from "./workspace-object.js";

type Owner = Pick<
  WorkspaceObject,
  "state" | "mutex" | "policy" | "current" | "isSelf" | "stub" | "control"
>;
interface ExecutionStorage {
  state: string;
  storageQuiescent?: boolean;
  result?: { sync: { status: string; skipped: unknown[] }; skipped: unknown[] };
  manifest?: D.Manifest;
  allocation: D.StoreAllocation;
  collection?: { requestId: string };
}
interface CollectionCredit {
  bytes: number;
  executionId: string;
}
interface CompletedClaim {
  kind: "local-upload";
  uploadId: string;
}
interface InstallSettlement {
  reservationId: string;
  disposition: "consumed";
}
interface Census {
  version: number;
  observedAt: number;
  bytes: number;
  children: Record<string, number>;
  registryHash: string;
}
interface Cached {
  input: WorkspaceStorageSampleInput;
  principalId: string;
  sample: WorkspaceStorageSample;
}
interface Permit {
  context: D.AuthContext;
  lookup: D.StoreLookup;
  registryVersion: number;
}
const metadataCredit = wireLimits.jsonBytes;
const samplePath = "/__fortipi/storage-sample";
const knownId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const lookup = (allocation: D.StoreLookup): D.StoreLookup => ({
  allocationId: allocation.allocationId,
  childId: allocation.childId,
  authorityId: allocation.authorityId,
  workspaceId: allocation.workspaceId,
});

/** Terminal output is readonly only after the actual runtime writer lane has closed. */
export function retainedScratch(row: ExecutionStorage | undefined): boolean {
  return Boolean(
    row?.state === "terminal" &&
      row.storageQuiescent === true &&
      row.result?.sync.status === "complete" &&
      row.result.sync.skipped.length === 0 &&
      row.result.skipped.length === 0,
  );
}

/** Existing CP-issued registration remains the trust boundary; this grants no file access. */
function authorizeSample(owner: Owner, ctx: D.AuthContext): void {
  const authority = owner.current();
  requireThat(
    owner.isSelf(authority.workspaceId) && !owner.state.get("child"),
    "unauthorized",
    "Storage authority required",
  );
  const lease = authority.lease;
  if (lease && ctx.grants.some((g) => permitsResource(g.resources.actions, "workspace.write"))) {
    authorizeReservedAction(owner.state, ctx, lease, "workspace.write");
    return;
  }
  if (ctx.grants.some((g) => permitsResource(g.resources.actions, "workspace.read"))) {
    authorize(owner.state, ctx, authority.workspaceId, "workspace.read");
    return;
  }
  for (const { value } of boundedRows<{
    principalId: string;
    expiresAt: number;
    state: string;
    request: { action: string; resources: D.ResourceScope };
  }>(owner, "export:")) {
    if (
      value.state === "expired" ||
      value.principalId !== ctx.principalId ||
      value.expiresAt <= Date.now()
    )
      continue;
    const { action, resources } = value.request;
    if (
      !ctx.grants.some(
        (g) =>
          (g.expiresAt === undefined || g.expiresAt > Date.now()) &&
          permitsResource(g.resources.actions, action) &&
          (Object.keys(resources) as (keyof D.ResourceScope)[]).every((key) =>
            resources[key].every((id) => permitsResource(g.resources[key], id)),
          ),
      )
    )
      continue;
    authorize(owner.state, ctx, authority.workspaceId, action);
    return;
  }
  requireThat(false, "unauthorized", "Current retained Workspace operation required for sampling");
}

function boundedRows<T>(owner: Owner, prefix: string): { key: string; value: T }[] {
  const rows: { key: string; value: T }[] = [];
  let after = "";
  let bytes = 0;
  const maximum =
    owner.policy.bounds.sqlPageRows *
    (owner.policy.bounds.retainedVersions +
      wireLimits.activeUploads +
      owner.policy.bounds.activeMutatingJobs);
  for (;;) {
    const page = owner.state.page<T>(prefix, after, owner.policy.bounds.sqlPageRows);
    for (const row of page) {
      bytes += new TextEncoder().encode(canonicalJson(row)).length;
      requireThat(
        rows.length < maximum && bytes <= wireLimits.jsonBytes,
        "quota_exceeded",
        "Complete storage registry exceeds bounded survey",
      );
      rows.push(row);
    }
    const last = page.at(-1);
    if (!last || page.length < Math.min(100, owner.policy.bounds.sqlPageRows)) return rows;
    after = last.key;
  }
}

/** Only an exact authority-created sampling permit bypasses the ordinary file registry lookup. */
export function storagePermit(owner: Owner, ctx: D.AuthContext, input: D.StoreLookup): boolean {
  const permit = owner.state.get<Permit>(`storage-permit:${ctx.requestId}:${input.allocationId}`);
  if (!permit || !same(permit.context, ctx) || !same(permit.lookup, lookup(input))) return false;
  authorizeSample(owner, ctx);
  const row = owner.state.get<AllocationRecord>(`allocation:${input.allocationId}`);
  return Boolean(
    row &&
      row.state.version === permit.registryVersion &&
      same(lookup(row.state.allocation), input) &&
      row.state.state !== "deleted",
  );
}

/** One pool per authority. Observed physical bytes and unspent estimates are deliberately separate. */
export class WorkspaceStorage {
  readonly owner: Owner;
  constructor(owner: Owner) {
    this.owner = owner;
  }
  private allocations(): AllocationRecord[] {
    const rows = boundedRows<AllocationRecord>(this.owner, "allocation:");
    const children = new Set<string>();
    for (const { key, value: row } of rows) {
      const a = row.state.allocation;
      const operationId = this.owner.state.get<string>(`capacity-id:${a.capacityReservationId}`);
      const capacity = this.owner.state.get<D.CapacityReservation>(`capacity:${operationId}`);
      requireThat(
        key === `allocation:${a.allocationId}` &&
          a.authorityId === this.owner.current().workspaceId &&
          a.workspaceId === a.authorityId &&
          !children.has(a.childId) &&
          this.owner.state.get(`capacity-allocation:${a.capacityReservationId}`) ===
            a.allocationId &&
          this.owner.state.get(`allocation-child:${a.childId}`) === a.allocationId &&
          capacity?.reservationId === a.capacityReservationId &&
          capacity.bytes >= a.reservedBytes,
        "conflict",
        "Complete physical registry ownership and capacity links required",
      );
      children.add(a.childId);
    }
    return rows.map((row) => row.value);
  }
  private complete(row: AllocationRecord): boolean {
    if (row.state.state === "sealed" && row.seal) return true;
    const allocation = row.state.allocation;
    return (
      allocation.role === "scratch" &&
      retainedScratch(this.owner.state.get<ExecutionStorage>(`execution:${allocation.executionId}`))
    );
  }
  private completedMetadata(): string[] {
    return boundedRows<CompletedClaim>(this.owner, "storage-completed:").flatMap(
      ({ key, value }) => {
        const id = key.slice("storage-completed:".length);
        const row = this.owner.state.get<{
          capacityReservationId?: string;
          status: { state: string };
        }>(`local-upload:${value.uploadId}`);
        return value.kind === "local-upload" &&
          row?.capacityReservationId === id &&
          ["committed", "aborted", "expired"].includes(row.status.state)
          ? [id]
          : [];
      },
    );
  }
  private survey(): string {
    const prefixes = [
      "allocation:",
      "capacity:",
      "capacity-id:",
      "capacity-allocation:",
      "install-capacity:",
      "allocate:",
      "allocation-child:",
      "allocation-lease:",
      "deallocated:",
      "execution:",
      "storage-initialized:",
      "storage-collection:",
      "storage-collection-credit:",
      "storage-completed:",
      "storage-credit:",
      "storage-export-credit:",
      "storage-install-intent:",
      "storage-install-ack:",
      "export:",
      "local-upload:",
      "reservation:",
      "lease-acquire:",
    ];
    const rows = prefixes.flatMap((prefix) => boundedRows<unknown>(this.owner, prefix));
    const value = canonicalJson({
      rows,
      authority: this.owner.current(),
      census: this.owner.state.get<Census>("storage-census") ?? null,
    });
    requireThat(
      new TextEncoder().encode(value).length <= wireLimits.jsonBytes,
      "quota_exceeded",
      "Complete storage survey exceeds bound",
    );
    return createHash("sha256").update(value).digest("hex");
  }
  charge(replacingOperation?: string): { observed: number; unspent: number; bytes: number } {
    const owner = this.owner;
    let observed = owner.state.bytes;
    let unspent = metadataCredit;
    const allocations = this.allocations();
    for (const row of allocations) {
      const allocation = row.state.allocation;
      if (
        row.state.state === "deleted" &&
        owner.state.get(`deallocated:${allocation.capacityReservationId}`)
      )
        continue;
      observed += owner.state.get<number>(`storage-observed:${allocation.childId}`) ?? 0;
      // Child receipt/cache/read metadata remains prospective even after a completed growth claim.
      unspent += metadataCredit;
    }
    for (const { value: capacity } of boundedRows<D.CapacityReservation>(owner, "capacity:")) {
      if (owner.state.get(`deallocated:${capacity.reservationId}`)) continue;
      if (!owner.state.get(`storage-credit:${capacity.reservationId}`)) unspent += capacity.bytes;
    }
    for (const { value } of boundedRows<CollectionCredit>(owner, "storage-collection:")) {
      const execution = owner.state.get<ExecutionStorage>(`execution:${value.executionId}`);
      const uploadOperation = execution?.collection
        ? `upload-${execution.collection.requestId}`
        : undefined;
      if (
        uploadOperation &&
        (uploadOperation === replacingOperation || owner.state.get(`capacity:${uploadOperation}`))
      )
        continue;
      if (owner.state.get(`storage-collection-credit:${value.executionId}`)) continue;
      unspent += value.bytes;
    }
    for (const { key, value } of boundedRows<{ state: string; reservedBytes?: number }>(
      owner,
      "export:",
    ))
      if (value.state !== "expired" && !owner.state.get(`storage-export-credit:${key}`))
        unspent += (value.reservedBytes ?? 0) * 2 + metadataCredit;
    return { observed, unspent, bytes: observed + unspent };
  }
  admit(growth = 0, replacingOperation?: string): void {
    const { bounds } = this.owner.policy;
    requireThat(
      this.charge(replacingOperation).bytes + growth <=
        bounds.workspaceBytes * (1 - bounds.headroomFraction),
      "quota_exceeded",
      "Workspace physical copies and unspent growth exhaust the shared pool",
    );
  }
  admitChild(role: D.StoreAllocation["role"]): void {
    const live = this.allocations().filter(
      (row) =>
        row.state.state !== "deleted" ||
        !this.owner.state.get(`deallocated:${row.state.allocation.capacityReservationId}`),
    );
    const active = live.filter(
      (row) => row.state.allocation.role === "scratch" && !this.complete(row),
    ).length;
    const retained = live.filter(
      (row) => row.state.allocation.role === "scratch" && this.complete(row),
    ).length;
    const revisions = live.filter((row) => row.state.allocation.role === "revision-store");
    requireThat(
      active <= this.owner.policy.bounds.activeMutatingJobs &&
        retained <= this.owner.policy.bounds.retainedVersions,
      "quota_exceeded",
      "Scratch role ceiling exceeded",
    );
    requireThat(
      role === "scratch"
        ? active < this.owner.policy.bounds.activeMutatingJobs &&
            retained < this.owner.policy.bounds.retainedVersions
        : revisions.filter((row) => !row.referenced).length < wireLimits.activeUploads &&
            revisions.filter((row) => row.referenced).length <=
              this.owner.policy.bounds.retainedVersions,
      "quota_exceeded",
      "Workspace live child role capacity exhausted",
    );
  }
  async initialized(ctx: D.AuthContext, allocation: D.StoreAllocation): Promise<void> {
    await this.owner.mutex.run(() => {
      authorizeSample(this.owner, ctx);
      const row = this.owner.state.get<AllocationRecord>(`allocation:${allocation.allocationId}`);
      requireThat(
        row && same(row.state.allocation, allocation) && row.state.state !== "deleted",
        "conflict",
        "Initialization acknowledgment no longer matches allocation",
      );
      this.owner.state.put(`storage-initialized:${allocation.allocationId}`, true);
    });
  }
  async reserveCollection(ctx: D.AuthContext, executionId: string, bytes: number): Promise<void> {
    await this.owner.mutex.run(() =>
      this.owner.state.transaction(() => {
        authorizeSample(this.owner, ctx);
        const prior = this.owner.state.get<CollectionCredit>(`storage-collection:${executionId}`);
        if (prior) {
          requireThat(prior.bytes === bytes, "conflict", "Collection growth intent changed");
          return;
        }
        this.admit(bytes);
        this.owner.state.put(`storage-collection:${executionId}`, {
          bytes,
          executionId,
        } satisfies CollectionCredit);
      }),
    );
  }
  private cached(
    ctx: D.AuthContext,
    input: WorkspaceStorageSampleInput,
  ): WorkspaceStorageSample | undefined {
    const prior = this.owner.state.get<Cached>(`storage-sample:${input.sampleId}`);
    if (!prior) return;
    requireThat(
      same(prior.input, input) && prior.principalId === ctx.principalId,
      "conflict",
      "Storage sample identity changed",
    );
    return prior.sample;
  }
  private save(
    ctx: D.AuthContext,
    input: WorkspaceStorageSampleInput,
    sample: WorkspaceStorageSample,
  ): void {
    this.owner.state.put(`storage-sample:${input.sampleId}`, {
      input,
      principalId: ctx.principalId,
      sample,
    } satisfies Cached);
  }
  async sample(
    ctx: D.AuthContext,
    input: WorkspaceStorageSampleInput,
  ): Promise<WorkspaceStorageSample> {
    requireThat(
      input &&
        knownId(input.sampleId) &&
        input.policyVersion === this.owner.policy.version &&
        same(
          Object.keys(input).sort(),
          (input.kind === "authority"
            ? ["kind", "policyVersion", "sampleId"]
            : ["kind", "lookup", "policyVersion", "registryVersion", "sampleId"]
          ).sort(),
        ) &&
        (input.kind === "authority" ||
          (input.kind === "child" &&
            Number.isSafeInteger(input.registryVersion) &&
            input.registryVersion > 0 &&
            input.lookup &&
            same(Object.keys(input.lookup).sort(), [
              "allocationId",
              "authorityId",
              "childId",
              "workspaceId",
            ]) &&
            knownId(input.lookup.allocationId) &&
            knownId(input.lookup.workspaceId) &&
            input.lookup.authorityId === input.lookup.workspaceId &&
            /^fortipi:child:[a-f0-9-]{36}$/.test(input.lookup.childId))),
      "invalid_request",
      "Exact typed Workspace storage sample required",
    );
    if (this.owner.state.get("child")) {
      requireThat(
        input.kind === "child" && this.owner.isSelf(input.lookup.childId),
        "unauthorized",
        "Exact child sample recipient required",
      );
      const check = async () => {
        const reply = await this.owner
          .stub(input.lookup.authorityId)
          .describeStore(ctx, input.lookup);
        requireThat(
          reply.ok &&
            reply.value.version === input.registryVersion &&
            same(lookup(reply.value.allocation), input.lookup) &&
            reply.value.state !== "deleted",
          "conflict",
          "Child sample registry changed",
        );
      };
      await check();
      const sample = await this.owner.mutex.run<WorkspaceStorageSample>(() => {
        requireThat(
          this.owner.state.get("child-initialized"),
          "conflict",
          "Uninitialized child cannot be sampled",
        );
        const current = this.owner.state.get<D.StoreState>("child");
        requireThat(
          current && same(lookup(current.allocation), input.lookup),
          "unauthorized",
          "Child owner mismatch",
        );
        return (
          this.cached(ctx, input) ?? {
            kind: "child",
            sampleId: input.sampleId,
            lookup: input.lookup,
            registryVersion: input.registryVersion,
            bytes: this.owner.state.bytes,
            observedAt: Date.now(),
          }
        );
      });
      await check();
      return this.owner.mutex.run(() => {
        this.save(ctx, input, sample);
        return sample;
      });
    }
    const cached = await this.owner.mutex.run(() => {
      authorizeSample(this.owner, ctx);
      return this.cached(ctx, input);
    });
    if (cached) return cached;
    if (input.kind === "child") return this.child(ctx, input);
    await this.settleCompleted(ctx);
    const before = await this.owner.mutex.run(() => {
      authorizeSample(this.owner, ctx);
      return this.survey();
    });
    const children: Record<string, number> = {};
    const completed: string[] = [];
    for (const row of this.allocations()) {
      const allocation = row.state.allocation;
      if (
        row.state.state === "deleted" &&
        this.owner.state.get(`deallocated:${allocation.capacityReservationId}`)
      )
        continue;
      requireThat(
        this.owner.state.get(`storage-initialized:${allocation.allocationId}`) ||
          row.seal ||
          (allocation.role === "scratch" &&
            this.owner.state.get(`execution:${allocation.executionId}`)),
        "interrupted",
        "Allocated or orphan child lacks confirmed initialization; retain full coverage",
      );
      const id = await digestJson("operation", {
        sampleId: input.sampleId,
        childId: allocation.childId,
      });
      const sample = await this.child(ctx, {
        kind: "child",
        sampleId: id,
        policyVersion: input.policyVersion,
        lookup: lookup(allocation),
        registryVersion: row.state.version,
      });
      children[allocation.childId] = sample.bytes;
      if (this.complete(row)) completed.push(allocation.capacityReservationId);
    }
    return this.owner.mutex.run(() =>
      this.owner.state.transaction(() => {
        authorizeSample(this.owner, ctx);
        requireThat(
          this.survey() === before,
          "conflict",
          "Complete Workspace census changed across observations",
        );
        const sample: WorkspaceStorageSample = {
          kind: "authority",
          sampleId: input.sampleId,
          bytes: this.owner.state.bytes,
          observedAt: Date.now(),
        };
        const version = incrementSafe(this.owner.state.get<Census>("storage-census")?.version ?? 0);
        for (const reservationId of completed)
          this.owner.state.put(`storage-credit:${reservationId}`, { censusVersion: version });
        for (const { key, value } of boundedRows<{ state: string }>(this.owner, "export:"))
          if (["ready", "partial", "unavailable"].includes(value.state))
            this.owner.state.put(`storage-export-credit:${key}`, { censusVersion: version });
        const completedMetadata = this.completedMetadata();
        for (const reservationId of completedMetadata)
          this.owner.state.put(`storage-credit:${reservationId}`, { censusVersion: version });
        for (const { value } of boundedRows<CollectionCredit>(this.owner, "storage-collection:")) {
          const execution = this.owner.state.get<ExecutionStorage>(
            `execution:${value.executionId}`,
          );
          if (execution?.manifest && retainedScratch(execution))
            this.owner.state.put(`storage-collection-credit:${value.executionId}`, {
              censusVersion: version,
            });
        }
        const census: Census = {
          version,
          observedAt: sample.observedAt,
          bytes: sample.bytes + Object.values(children).reduce((sum, bytes) => sum + bytes, 0),
          children,
          registryHash: before,
        };
        this.owner.state.put("storage-census", census);
        for (const [childId, bytes] of Object.entries(children))
          this.owner.state.put(`storage-observed:${childId}`, bytes);
        const coveredReservationIds = [
          ...new Set(
            [
              ...completed,
              ...completedMetadata,
              ...boundedRows<InstallSettlement>(this.owner, "storage-install-ack:").map((row) =>
                row.key.slice("storage-install-ack:".length),
              ),
            ]
              .map(
                (id) =>
                  this.owner.state.get<InstallSettlement>(`storage-install-ack:${id}`)
                    ?.reservationId,
              )
              .filter(
                (id): id is string =>
                  Boolean(id) && !this.owner.state.get(`storage-install-covered:${id}`),
              ),
          ),
        ];
        requireThat(
          coveredReservationIds.length <= 100,
          "quota_exceeded",
          "Completed growth claim batch exceeds bound",
        );
        this.owner.state.put("storage-report", {
          sampleId: input.sampleId,
          policyVersion: input.policyVersion,
          sampleSeq: version,
          observedAt: sample.observedAt,
          coverage: { kind: "workspace", bytes: census.bytes, censusVersion: version },
          coveredReservationIds,
        } satisfies StorageSampleInput);
        this.save(ctx, input, sample);
        return sample;
      }),
    );
  }
  private async child(
    ctx: D.AuthContext,
    input: Extract<WorkspaceStorageSampleInput, { kind: "child" }>,
  ): Promise<WorkspaceStorageSample> {
    await this.owner.mutex.run(() => {
      authorizeSample(this.owner, ctx);
      const row = this.owner.state.get<AllocationRecord>(`allocation:${input.lookup.allocationId}`);
      requireThat(
        row &&
          row.state.version === input.registryVersion &&
          same(lookup(row.state.allocation), input.lookup) &&
          row.state.state !== "deleted" &&
          (this.owner.state.get(`storage-initialized:${input.lookup.allocationId}`) ||
            row.seal ||
            (row.state.allocation.role === "scratch" &&
              this.owner.state.get(`execution:${row.state.allocation.executionId}`))),
        "conflict",
        "Known initialized registry child and exact version required",
      );
      this.owner.state.put(`storage-permit:${ctx.requestId}:${input.lookup.allocationId}`, {
        context: ctx,
        lookup: input.lookup,
        registryVersion: input.registryVersion,
      } satisfies Permit);
    });
    try {
      const response = await this.owner.stub(input.lookup.childId).fetch(
        new Request(`https://workspace.internal${samplePath}`, {
          method: "POST",
          headers: { [internalHeader]: JSON.stringify({ auth: ctx }) },
          body: JSON.stringify(input),
        }),
      );
      requireThat(response.ok, "interrupted", "Physical child sample unavailable; retain coverage");
      const sample = (await response.json()) as WorkspaceStorageSample;
      requireThat(
        sample.kind === "child" &&
          sample.sampleId === input.sampleId &&
          same(sample.lookup, input.lookup) &&
          sample.registryVersion === input.registryVersion &&
          Number.isSafeInteger(sample.bytes) &&
          sample.bytes >= 0 &&
          Number.isSafeInteger(sample.observedAt) &&
          sample.observedAt <= Date.now(),
        "conflict",
        "Child sample receipt mismatch",
      );
      await this.owner.mutex.run(() => {
        requireThat(
          storagePermit(this.owner, ctx, input.lookup),
          "conflict",
          "Registry changed after child sample",
        );
        const old = this.owner.state.get<number>(`storage-observed:${input.lookup.childId}`) ?? 0;
        if (sample.bytes > old)
          this.owner.state.put(`storage-observed:${input.lookup.childId}`, sample.bytes);
        this.save(ctx, input, sample);
      });
      return sample;
    } finally {
      await this.owner.mutex.run(() =>
        this.owner.state.delete(`storage-permit:${ctx.requestId}:${input.lookup.allocationId}`),
      );
    }
  }
  async refresh(ctx: D.AuthContext): Promise<void> {
    await this.sample(ctx, {
      kind: "authority",
      sampleId: crypto.randomUUID(),
      policyVersion: this.owner.policy.version,
    });
    await this.report(ctx);
  }
  private async settleCompleted(ctx: D.AuthContext): Promise<void> {
    const candidates = await this.owner.mutex.run(() => {
      authorizeSample(this.owner, ctx);
      return [
        ...this.allocations()
          .filter((row) => this.complete(row))
          .map((row) => row.state.allocation.capacityReservationId),
        ...this.completedMetadata(),
      ];
    });
    for (const id of new Set(candidates)) {
      const intent = await this.owner.mutex.run(() => {
        authorizeSample(this.owner, ctx);
        const row = this.allocations().find(
          (row) => row.state.allocation.capacityReservationId === id,
        );
        if (!(row ? this.complete(row) : this.completedMetadata().includes(id))) return;
        const reservationId = this.owner.state.get<string>(`install-capacity:${id}`);
        if (!reservationId || this.owner.state.get(`storage-install-ack:${id}`)) return;
        const value: InstallSettlement = { reservationId, disposition: "consumed" };
        const prior = this.owner.state.get<InstallSettlement>(`storage-install-intent:${id}`);
        requireThat(
          !prior || same(prior, value),
          "conflict",
          "Immutable installation settlement changed",
        );
        this.owner.state.put(`storage-install-intent:${id}`, value);
        return value;
      });
      if (!intent) continue;
      try {
        const result = await this.owner.control().settleCapacity(ctx, intent);
        if (
          !result.ok ||
          result.value.state !== "settled" ||
          result.value.reservationId !== intent.reservationId
        )
          continue;
        await this.owner.mutex.run(() => {
          authorizeSample(this.owner, ctx);
          requireThat(
            same(this.owner.state.get(`storage-install-intent:${id}`), intent),
            "conflict",
            "Settlement intent changed after acknowledgment",
          );
          this.owner.state.put(`storage-install-ack:${id}`, intent);
        });
      } catch {
        // Logical-export or recovery authority cannot impersonate the original CP principal.
        // Its truthful physical census may proceed, with this growth claim still uncovered.
      }
    }
  }
  async settleDeleted(ctx: D.AuthContext, localId: string): Promise<void> {
    authorize(this.owner.state, ctx, this.owner.current().workspaceId, "workspace.write");
    const intent = this.owner.state.get<InstallSettlement>(`storage-install-intent:${localId}`);
    if (intent) {
      if (this.owner.state.get(`storage-install-ack:${localId}`)) return;
      const result = await this.owner.control().settleCapacity(ctx, intent);
      requireThat(
        result.ok &&
          result.value.state === "settled" &&
          result.value.reservationId === intent.reservationId,
        "interrupted",
        "Original installation completion settlement is unresolved",
      );
      await this.owner.mutex.run(() => {
        authorize(this.owner.state, ctx, this.owner.current().workspaceId, "workspace.write");
        this.owner.state.put(`storage-install-ack:${localId}`, intent);
      });
      return;
    }
    const reservationId = this.owner.state.get<string>(`install-capacity:${localId}`);
    if (!reservationId) return;
    const result = await this.owner
      .control()
      .settleCapacity(ctx, { reservationId, disposition: "unused", observedBytes: 0 });
    requireThat(result.ok, "interrupted", "Confirmed deallocation settlement is unresolved");
  }
  async report(ctx: D.AuthContext): Promise<void> {
    const report = await this.owner.mutex.run(() => {
      authorizeSample(this.owner, ctx);
      return this.owner.state.get<StorageSampleInput>("storage-report");
    });
    if (!report || this.owner.state.get(`storage-report-ack:${report.sampleId}`)) return;
    requireThat(
      ctx.registrationId,
      "unauthorized",
      "Current Workspace recipient registration required",
    );
    const registered: D.ResourceAuthContext = { ...ctx, registrationId: ctx.registrationId };
    try {
      const response = await this.owner.control().fetch(
        new Request("https://control.internal/internal/storage-sample", {
          method: "POST",
          headers: { "X-Fortipi-Context": JSON.stringify(registered) },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, ctx.deadline - Date.now()))),
        }),
      );
      if (!response.ok) return; // Retain the exact pending sample; never claim installation reconciliation.
      const receipt = (await response.json()) as D.Outcome<{
        sampleSeq: number;
        chargeBytes: number;
      }>;
      if (
        !receipt.ok ||
        receipt.value.sampleSeq !== report.sampleSeq ||
        !Number.isSafeInteger(receipt.value.chargeBytes) ||
        receipt.value.chargeBytes < 0
      )
        return;
      await this.owner.mutex.run(() => {
        authorizeSample(this.owner, ctx);
        this.owner.state.put(`storage-report-ack:${report.sampleId}`, receipt.value);
        for (const id of report.coveredReservationIds)
          this.owner.state.put(`storage-install-covered:${id}`, true);
      });
    } catch {
      // The local completed census is durable. CP remains responsible for its own installation admission.
    }
  }
}
