import {
  localIntentDigest,
  validateChunkInventory,
  validateLocalLease,
  validateLocalStage,
} from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { emptyScope, requireGrant } from "./authorization.js";
import type { LocalTransport } from "./delivery.js";
import { valid } from "./directory.js";
import type { Executors } from "./executors.js";
import type { Identities } from "./identity.js";
import { check, hash, id, json, ref, type Store, same } from "./store.js";

export interface LocalReadEvidence {
  request: D.LocalReadRequest;
  reference: D.ByteReference;
}
export const readEvidenceKey = (ctx: D.AuthContext, operationId: string): string =>
  `${ctx.principalId}:${operationId}`;

export class LocalWorkspace {
  readonly store: Store;
  readonly identities: Identities;
  readonly executors: Executors;
  readonly env: Env;
  constructor(store: Store, identities: Identities, executors: Executors, env: Env) {
    this.store = store;
    this.identities = identities;
    this.executors = executors;
    this.env = env;
  }
  async renew(ctx: D.AuthContext, lease: D.WorkspaceOperationLease): Promise<void> {
    const prepared = this.store.get<{ request: D.LocalPrepare }>(
      "local_prepared",
      `${ctx.principalId}:${lease.operationId}`,
    );
    if (!prepared) return;
    check(
      prepared.request.lease.leaseId === lease.leaseId,
      "conflict",
      "Local renewal lease identity changed",
    );
    const response = await this.request(ctx, { ...prepared.request, lease });
    check(
      "state" in response && response.state === "prepared",
      "conflict",
      "Local renewal lacks preparation acknowledgment",
    );
  }
  async request(
    ctx: D.AuthContext,
    input: D.LocalWorkspaceRequest,
  ): Promise<D.LocalWorkspaceResponse> {
    this.identities.current(ctx);
    check(
      new TextEncoder().encode(json(input)).length <= 1048576,
      "payload_too_large",
      "Local request exceeds the transport body bound",
    );
    check(
      valid("workspaces", "LocalWorkspaceRequest", input),
      "invalid_request",
      "Invalid local request",
    );
    const mutating = input.kind === "prepare" || input.kind === "apply";
    if (input.kind === "prepare" && input.mode.kind === "staged-change") {
      const caps = this.executors.transferLimits(input.executorId, input.executorGeneration);
      check(
        input.mode.manifest.entries.length <= caps.manifestEntries &&
          input.mode.manifest.entries.reduce(
            (sum, entry) => sum + (entry.type === "file" ? entry.size : 0),
            0,
          ) <= caps.snapshotBytes &&
          input.mode.mutations.every(
            (mutation) => mutation.kind !== "put" || mutation.size <= caps.fileBytes,
          ),
        "payload_too_large",
        "Local preparation exceeds current registered bounds",
      );
    }
    if (input.kind === "prepare" && input.mode.kind === "staged-change")
      await validateLocalStage(input.mode);
    requireGrant(ctx, mutating ? "workspace.write" : "workspace.read", {
      ...emptyScope(),
      workspaceIds: [input.workspaceId],
      executorIds: [input.executorId],
    });
    if (input.kind !== "observe" && input.kind !== "receipt")
      check(same(ref(ctx), input.credential), "unauthorized", "Local authority mismatch");
    if (mutating)
      check(
        "lease" in input && input.lease.expiresAt > Date.now() && input.deadline > Date.now(),
        "conflict",
        "Local lease expired",
      );
    if (mutating) {
      const disposition =
        "lease" in input
          ? this.store.get<{ state?: string }>("lease", input.lease.leaseId)?.state
          : undefined;
      check(
        disposition !== "released" && disposition !== "releasing",
        "conflict",
        "Local lease is closing or released",
      );
      const reservation = this.store.get<D.TargetReservation>(
        "reservation",
        `${ctx.principalId}:${input.operationId}`,
      );
      check(
        "lease" in input &&
          reservation &&
          reservation.workspaceId === input.workspaceId &&
          reservation.bindingVersion === input.bindingVersion &&
          reservation.operationDigest === input.operationDigest &&
          same(reservation.credential, input.credential) &&
          reservation.target.kind === "executor" &&
          reservation.target.executorId === input.executorId &&
          reservation.target.generation === input.executorGeneration &&
          input.lease.registrationId === reservation.registrationIds.workspace &&
          input.deadline <= reservation.deadline,
        "unauthorized",
        "Local effect requires its actual reserved authority",
      );
      if (input.kind === "prepare" && input.mode.kind === "native-execution")
        check(
          reservation.ownerKind === "job" &&
            reservation.jobId === input.mode.jobId &&
            reservation.executionId === input.mode.executionId,
          "conflict",
          "Native preparation changed reserved execution identity",
        );
    }
    if ("lease" in input)
      validateLocalLease(
        input,
        input.kind as "prepare" | "apply" | "observe" | "receipt",
        Date.now(),
      );
    const digest = await hash(json(input));
    const correlationId = await hash(
      `${ctx.principalId}:${input.operationId}:${input.kind}:${digest}`,
    );
    let stored = this.store.get<LocalTransport>("local_transport", correlationId);
    // Nonterminal observation is a query of current journal evidence, not a cached outcome.
    if (
      input.kind === "observe" &&
      stored?.response &&
      !("state" in stored.response && stored.response.state === "applied")
    )
      stored = undefined;
    if (input.kind === "prepare") {
      const previous = this.store.get<{ request: D.LocalPrepare }>(
        "local_prepared",
        `${ctx.principalId}:${input.operationId}`,
      );
      const stable = (request: D.LocalPrepare): unknown => {
        const { leaseVersion: _version, expiresAt: _expiry, ...lease } = request.lease;
        return { ...request, lease };
      };
      check(
        !previous || same(stable(previous.request), stable(input)),
        "conflict",
        "Local preparation identity changed",
      );
    }
    if (input.kind === "apply") {
      const prepared = this.store.get<{
        request: D.LocalPrepare;
        preparation: D.LocalPrepared;
        intent: D.LocalCommitIntent;
      }>("local_prepared", `${ctx.principalId}:${input.operationId}`);
      check(
        prepared &&
          input.preparationId === prepared.preparation.preparationId &&
          input.commitId === prepared.intent.commitId &&
          input.operationDigest === prepared.request.operationDigest,
        "conflict",
        "Local apply lacks persisted workspace intent",
      );
      check(
        (await localIntentDigest({
          scope: input,
          commitId: input.commitId,
          preparationId: input.preparationId,
          preManifestHash: prepared.preparation.preManifestHash,
          ...(prepared.intent.expectedPostManifestHash === undefined
            ? {}
            : { expectedPostManifestHash: prepared.intent.expectedPostManifestHash }),
        })) === prepared.intent.intentDigest,
        "conflict",
        "Apply changed immutable intent scope",
      );
      const knownLease =
        this.store.get<{ lease: D.Lease }>("lease", input.lease.leaseId)?.lease ??
        prepared.intent.scope.lease;
      check(
        same(knownLease, input.lease),
        "conflict",
        "Apply needs the actual current lease observation",
      );
      const previous = this.store.get<{ digest: string }>(
        "local_apply",
        `${ctx.principalId}:${input.operationId}`,
      );
      if (previous && !(stored?.response && !("error" in stored.response))) {
        check(previous.digest === digest, "conflict", "Local apply identity changed");
        const { kind: _kind, ...scope } = input;
        return this.request(ctx, { ...scope, kind: "observe" });
      }
    }
    if (input.kind === "receipt") {
      const authority = this.env.WORKSPACES.getByName(input.workspaceId);
      check(
        (await authority.contractVersion) === "1.0",
        "unsupported",
        "Workspace contract mismatch",
      );
      const found = await authority.getReceipt(ctx, {
        workspaceId: input.workspaceId,
        commitId: input.receipt.commitId,
        commitDigest: input.receipt.commitDigest,
      });
      check(
        found.ok && same(found.value, input.receipt),
        "conflict",
        "Local receipt lacks workspace evidence",
      );
    }
    const requestId = stored?.requestId ?? id();
    let response: D.LocalWorkspaceResponse | D.ErrorBody;
    if (stored?.response) response = stored.response;
    else {
      this.store.tx(() => {
        this.identities.current(ctx);
        if (input.kind === "apply") {
          const key = `${ctx.principalId}:${input.operationId}`;
          check(
            !this.store.get("local_apply", key),
            "conflict",
            "Apply was already attempted; observe existing operation",
          );
          this.store.put("local_apply", key, { digest, correlationId });
        }
        this.store.put("local_transport", correlationId, {
          request: input,
          requestId,
          correlationId,
          attempted: true,
        } satisfies LocalTransport);
      });
      const frame = await this.executors.exchange(
        input.executorId,
        input.executorGeneration,
        {
          type: "workspace.request",
          requestId,
          payload: { requestId, correlationId, request: input },
        },
        ctx.deadline,
      );
      check(
        frame.type === "workspace.response" &&
          frame.payload.correlationId === correlationId &&
          frame.payload.requestId === requestId,
        "conflict",
        "Local response correlation mismatch",
      );
      response = frame.payload.response;
    }
    check(!("error" in response), "conflict", "Executor reported local conflict");
    check(
      valid("workspaces", "LocalWorkspaceResponse", response),
      "conflict",
      "Invalid local response",
    );
    if (input.kind === "read") {
      check(
        "kind" in response && response.kind === "read",
        "conflict",
        "Read response kind mismatch",
      );
      const reference = response.result;
      const endpoint = new URL(reference.endpoint, "https://control.internal");
      check(
        reference.workspaceId === input.workspaceId &&
          reference.revision === input.revision &&
          reference.owner.kind === "local" &&
          reference.owner.executorId === input.executorId &&
          reference.endpoint.split("?")[0] === `/v1/workspaces/${input.workspaceId}/read` &&
          !reference.endpoint.includes("#") &&
          [...endpoint.searchParams].every(
            ([key, value]) =>
              (key === "revision" && value === input.revision) ||
              (key === "path" && value === input.path),
          ) &&
          endpoint.searchParams.size <= 2 &&
          reference.chunks !== undefined,
        "conflict",
        "Local read metadata does not match its owner and revision",
      );
      validateChunkInventory(reference.chunks, reference.size);
      const { transfers: _transfers, ...metadataRequest } = input;
      const key = readEvidenceKey(ctx, input.operationId);
      const previous = this.store.get<LocalReadEvidence>("local_read", key);
      if (previous)
        check(
          same(previous.request, metadataRequest) && same(previous.reference, reference),
          "conflict",
          "Local read metadata changed within an operation",
        );
      else {
        check(input.transfers === undefined, "conflict", "Read metadata must precede a producer");
        this.identities.current(ctx);
        this.store.put("local_read", key, {
          request: metadataRequest,
          reference,
        } satisfies LocalReadEvidence);
      }
    }
    if (input.kind === "prepare") {
      check(
        "state" in response &&
          response.state === "prepared" &&
          "expiresAt" in response &&
          response.operationId === input.operationId &&
          response.operationDigest === input.operationDigest &&
          response.preManifestHash === input.expectedManifestHash &&
          response.expiresAt > Date.now() &&
          response.expiresAt <= Math.min(input.lease.expiresAt, input.deadline) &&
          (input.mode.kind !== "staged-change" ||
            response.stagedDigest === input.mode.stagedDigest),
        "conflict",
        "Preparation does not match request",
      );
      const preparation = response as D.LocalPrepared;
      const authority = this.env.WORKSPACES.getByName(input.workspaceId);
      check(
        (await authority.contractVersion) === "1.0",
        "unsupported",
        "Workspace contract mismatch",
      );
      const intent = await authority.prepareLocalCommit(ctx, {
        scope: {
          operationId: input.operationId,
          operationDigest: input.operationDigest,
          workspaceId: input.workspaceId,
          bindingVersion: input.bindingVersion,
          rootBindingId: input.rootBindingId,
          executorId: input.executorId,
          executorGeneration: input.executorGeneration,
          credential: input.credential,
          baseRevision: input.baseRevision,
          lease: input.lease,
          deadline: input.deadline,
        },
        commitId: input.commitId,
        preparation,
        ...(input.mode.kind === "staged-change"
          ? { expectedPostManifestHash: input.mode.postManifestHash }
          : {}),
      });
      check(
        intent.ok &&
          intent.value.preparationId === preparation.preparationId &&
          intent.value.commitId === input.commitId &&
          intent.value.scope.operationDigest === input.operationDigest,
        "conflict",
        "Workspace did not persist matching preparation",
      );
      check(
        intent.value.intentDigest ===
          (await localIntentDigest({
            scope: input,
            commitId: input.commitId,
            preparationId: preparation.preparationId,
            preManifestHash: preparation.preManifestHash,
            ...(input.mode.kind === "staged-change"
              ? { expectedPostManifestHash: input.mode.postManifestHash }
              : {}),
          })),
        "conflict",
        "Workspace intent digest mismatch",
      );
      this.identities.current(ctx);
      this.store.put("local_prepared", `${ctx.principalId}:${input.operationId}`, {
        request: input,
        preparation,
        intent: intent.value,
      });
      const known = this.store.get<{ lease: D.Lease }>("lease", intent.value.scope.lease.leaseId);
      if (!known || known.lease.leaseVersion <= intent.value.scope.lease.leaseVersion)
        this.store.put("lease", intent.value.scope.lease.leaseId, {
          ...known,
          lease: intent.value.scope.lease,
        });
    }
    if (input.kind === "apply" || input.kind === "observe")
      check(
        "operationDigest" in response &&
          response.operationDigest === input.operationDigest &&
          response.operationId === input.operationId &&
          "commitId" in response &&
          response.commitId === input.commitId &&
          (input.preparationId === undefined || response.preparationId === input.preparationId),
        "conflict",
        "Observation scope mismatch",
      );
    if (!("lease" in input))
      check(
        "kind" in response && response.kind === input.kind,
        "conflict",
        "Read response kind mismatch",
      );
    if (!("lease" in input) && "kind" in response && "result" in response)
      check(
        response.result.revision === input.revision &&
          (input.kind !== "diff" ||
            (response.kind === "diff" && response.result.otherRevision === input.otherRevision)),
        "conflict",
        "Read returned a different retained revision",
      );
    if (input.kind === "receipt")
      check(
        "persisted" in response && response.persisted === true,
        "conflict",
        "Receipt response lacks a durable acknowledgment",
      );
    this.identities.current(ctx);
    return response;
  }
}
