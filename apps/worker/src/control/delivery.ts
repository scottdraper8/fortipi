import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { indexArtifacts } from "./artifact-index.js";
import { emptyScope, permits, requireGrant } from "./authorization.js";
import { type Directory, valid } from "./directory.js";
import { type DispatchRecord, sameExecution } from "./dispatch.js";
import type { Executors } from "./executors.js";
import type { Identities } from "./identity.js";
import { postponeRepair, repairAccepted } from "./repair.js";
import { check, fail, hash, id, json, next, ref, type Store, same, within } from "./store.js";
import type { ExecutorState, Tickets } from "./tickets.js";

interface Inbox {
  digest: string;
  ack: D.DeliveryAck;
  ctx: D.AuthContext;
  frame: D.ExecutorFrame;
  executionId?: string;
  attempts: number;
}
interface Command {
  ctx: D.AuthContext;
  delivery: D.ExecutorDelivery & { connectionEpoch: number };
  ack: D.DeliveryAck;
  digest: string;
  attempts: number;
  workspaceProofAction?: string;
}
export interface LocalTransport {
  request: D.LocalWorkspaceRequest;
  requestId: string;
  correlationId: string;
  attempted: boolean;
  response?: D.LocalWorkspaceResponse | D.ErrorBody;
}
export class Delivery {
  readonly store: Store;
  readonly identities: Identities;
  readonly directory: Directory;
  readonly env: Env;
  readonly tickets: Tickets;
  constructor(
    store: Store,
    identities: Identities,
    directory: Directory,
    env: Env,
    tickets: Tickets,
  ) {
    this.store = store;
    this.identities = identities;
    this.directory = directory;
    this.env = env;
    this.tickets = tickets;
  }
  async forward(
    ctx: D.AuthContext,
    input: D.ExecutorDelivery,
    executors: Executors,
  ): Promise<D.DeliveryAck> {
    this.identities.current(ctx);
    const frame = input.frame;
    check(
      frame.type === "job.lease_update" || frame.type === "job.committed",
      "unauthorized",
      "Only authority lease and commit evidence can be forwarded",
    );
    const identity = frame.payload.identity;
    const record = this.store.get<DispatchRecord>("dispatch", identity.executionId);
    check(
      record?.attempted &&
        sameExecution(record.intent.assignment.identity, identity) &&
        identity.target.kind === "executor" &&
        identity.target.executorId === input.executorId &&
        identity.target.generation === input.generation,
      "conflict",
      "Command execution mismatch",
    );
    const resources = {
      ...emptyScope(),
      agentIds: [record.intent.reservation.agentId],
      conversationIds: [record.intent.reservation.conversationId],
      workspaceIds: [record.intent.reservation.workspaceId],
      executorIds: [input.executorId],
      tools: [record.intent.assignment.tool],
    };
    requireGrant(ctx, "jobs.dispatch", resources);
    const target = this.store.get<ExecutorState>("executor", input.executorId);
    check(
      target && target.status !== "revoked" && target.generation === input.generation,
      "conflict",
      "Command executor generation changed",
    );
    const connectionEpoch =
      input.connectionEpoch === undefined ? target.epoch : input.connectionEpoch;
    check(
      Number.isSafeInteger(connectionEpoch) &&
        connectionEpoch > 0 &&
        connectionEpoch === target.epoch,
      "conflict",
      "Command connection epoch is invalid or stale",
    );
    const delivery = { ...input, connectionEpoch };
    const workspaceResources = { ...resources, tools: [] };
    let workspaceProofAction: string | undefined;
    const currentAuthority = (): void => {
      this.identities.current(ctx);
      requireGrant(ctx, "jobs.dispatch", resources);
      if (workspaceProofAction) requireGrant(ctx, workspaceProofAction, workspaceResources);
      const executor = this.store.get<ExecutorState>("executor", input.executorId);
      check(
        executor &&
          executor.status !== "revoked" &&
          executor.generation === input.generation &&
          executor.epoch === connectionEpoch,
        "conflict",
        "Terminal executor authority changed",
      );
    };
    currentAuthority();
    if (frame.type === "job.lease_update") {
      const old = record.intent.assignment.identity.lease;
      check(
        old.leaseId === identity.lease.leaseId &&
          old.fence === identity.lease.fence &&
          old.baseRevision === identity.lease.baseRevision &&
          same(old.credential, identity.lease.credential) &&
          frame.payload.expiresAt <= identity.deadline,
        "conflict",
        "Lease update cannot change identity or revive expiry",
      );
    } else {
      check(
        frame.payload.terminalVersion > 0 && frame.payload.eventSeq > 0,
        "conflict",
        "Terminal coordinates are required",
      );
      const proofScope = { ...resources, actions: ["jobs.dispatch"] };
      const reservedActions = record.intent.reservation.actions.filter(
        (action) => action === "workspace.write" || action === "workspace.read",
      );
      const candidates =
        frame.payload.evidence.kind === "committed"
          ? reservedActions.includes("workspace.write")
            ? ["workspace.write"]
            : []
          : reservedActions.length
            ? ["workspace.read", "workspace.write"]
            : [];
      const workspaceAction = candidates.find((action) =>
        permits(ctx.grants, workspaceResources, action),
      );
      check(
        workspaceAction,
        "unauthorized",
        "Terminal proof needs current authority for the reserved workspace operation",
      );
      requireGrant(ctx, workspaceAction, workspaceResources);
      workspaceProofAction = workspaceAction;
      const workspaceRegistration = this.tickets.register(ctx, {
        credential: ref(ctx),
        recipient: { kind: "workspace", id: record.intent.reservation.workspaceId },
        resources: { ...workspaceResources, actions: [workspaceAction] },
        executor: { executorId: input.executorId, generation: input.generation },
      });
      const agentRegistration = this.tickets.register(ctx, {
        credential: ref(ctx),
        recipient: { kind: "agent", id: record.intent.reservation.agentId },
        resources: proofScope,
        executor: { executorId: input.executorId, generation: input.generation },
      });
      const workspace = this.env.WORKSPACES.getByName(record.intent.reservation.workspaceId);
      const agent = this.env.AGENT_SESSIONS.getByName(record.intent.reservation.agentId);
      const versions = await within(
        Promise.all([workspace.contractVersion, agent.contractVersion]),
        Math.max(1, Math.min(5000, ctx.deadline - Date.now())),
      );
      currentAuthority();
      check(
        versions.every((version) => version === "1.0"),
        "unsupported",
        "Terminal proof contract mismatch",
      );
      const signal = AbortSignal.timeout(Math.max(1, Math.min(5000, ctx.deadline - Date.now())));
      const payload = json(frame.payload);
      check(
        new TextEncoder().encode(payload).length <= 65536,
        "payload_too_large",
        "Terminal proof exceeds body bound",
      );
      const workspaceRequest = new Request("https://workspace.internal/__fortipi/terminal-proof", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-fortipi-workspace-context": json({
            auth: { ...ctx, registrationId: workspaceRegistration.registrationId },
          }),
        },
        body: payload,
        signal,
      });
      const agentRequest = new Request(
        `https://agent.internal/__fortipi/terminal-proof/${identity.jobId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fortipi-Context": json({ ...ctx, registrationId: agentRegistration.registrationId }),
          },
          body: payload,
          signal,
        },
      );
      const replies = await within(
        Promise.all([
          workspace.fetch(workspaceRequest, { signal }),
          agent.fetch(agentRequest, { signal }),
        ]),
        Math.max(1, Math.min(5000, ctx.deadline - Date.now())),
      );
      currentAuthority();
      for (const response of replies) {
        check(
          response.headers
            .get("Cache-Control")
            ?.split(",")
            .some((value) => value.trim().toLowerCase() === "no-store"),
          "conflict",
          "Terminal proof must not be cached",
        );
        const proof = await boundedProof(response, Math.min(ctx.deadline, Date.now() + 5000), () =>
          currentAuthority(),
        );
        currentAuthority();
        if (response.status !== 200) {
          if (
            proof &&
            typeof proof === "object" &&
            "error" in proof &&
            isProtocolError(proof.error)
          )
            fail(proof.error.code, "Terminal proof unavailable", proof.error.details);
          fail("unavailable", "Terminal proof unavailable");
        }
        check(
          valid("executor-messages", "ExecutorFrame", {
            type: "job.committed",
            requestId: frame.requestId,
            payload: proof,
          }) && same(proof, frame.payload),
          "conflict",
          "Actual terminal proof does not match",
        );
      }
    }
    const digest = await hash(json(frame.payload));
    currentAuthority();
    const key = `${identity.executionId}:${frame.type}:${frame.type === "job.committed" ? frame.payload.terminalVersion : frame.payload.leaseVersion}`;
    await this.store.arm();
    currentAuthority();
    const command = this.store.tx(() => {
      currentAuthority();
      const current = this.store.get<DispatchRecord>("dispatch", identity.executionId);
      const executor = this.store.get<ExecutorState>("executor", input.executorId);
      check(
        current?.attempted &&
          sameExecution(current.intent.assignment.identity, identity) &&
          executor &&
          executor.status !== "revoked" &&
          executor.generation === input.generation,
        "conflict",
        "Authority changed while terminal proof was awaited",
      );
      const old = this.store.get<Command>("command", key);
      if (frame.type === "job.lease_update") {
        const original = current.intent.assignment.identity.lease;
        const owner = this.store.get<import("./identity.js").CredentialRecord>(
          "credential",
          original.credential.credentialId,
        );
        check(
          owner &&
            owner.status === "active" &&
            same(ref(owner), original.credential) &&
            (owner.expiresAt === null || owner.expiresAt > Date.now()),
          "unauthenticated",
          "Original lease authority revoked or expired",
        );
        const grant = owner.grants.find((grant) => permits([grant], resources, "jobs.dispatch"));
        check(grant, "unauthorized", "Original execution grant expired");
        if (!old) {
          const retained =
            this.store.get<{ lease: D.Lease }>("lease", original.leaseId)?.lease ?? original;
          check(
            retained.expiresAt > Date.now() &&
              frame.payload.leaseVersion > retained.leaseVersion &&
              frame.payload.expiresAt > Date.now() &&
              frame.payload.expiresAt <=
                Math.min(
                  identity.deadline,
                  Date.now() + 30000,
                  owner.expiresAt ?? Number.MAX_SAFE_INTEGER,
                  grant.expiresAt ?? Number.MAX_SAFE_INTEGER,
                ),
            "conflict",
            "Lease update cannot revive expiry or regress the retained version",
          );
          this.store.put("lease", original.leaseId, {
            lease: {
              ...retained,
              leaseVersion: frame.payload.leaseVersion,
              expiresAt: frame.payload.expiresAt,
            },
          });
        }
      }
      if (old) {
        check(old.digest === digest, "conflict", "Authority command changed");
        old.ctx = ctx;
        // Only this freshly authorized foreground attempt may recapture an epoch.
        // The payload/digest and durable transport receipt remain unchanged.
        old.delivery = delivery;
        if (workspaceProofAction) old.workspaceProofAction = workspaceProofAction;
        this.store.put("command", key, old, "", "", Date.now());
        return old;
      }
      const command: Command = {
        ctx,
        delivery,
        digest,
        ack: {
          deliveryId: id(),
          sequence:
            frame.type === "job.committed"
              ? frame.payload.terminalVersion
              : frame.payload.leaseVersion,
          persisted: true,
        },
        attempts: 0,
        ...(workspaceProofAction ? { workspaceProofAction } : {}),
      };
      this.store.put("command", key, command, "", "", Date.now());
      return command;
    });
    await this.drainCommand(key, executors);
    return command.ack;
  }
  async drainCommand(key: string, executors: Executors): Promise<void> {
    const command = this.store.get<Command>("command", key);
    if (!command) return;
    try {
      const liveCtx = { ...command.ctx, deadline: Date.now() + 5000 };
      this.identities.current(liveCtx);
      const frame = command.delivery.frame;
      check(
        frame.type === "job.lease_update" || frame.type === "job.committed",
        "conflict",
        "Unknown authority command",
      );
      const dispatch = this.store.get<DispatchRecord>(
        "dispatch",
        frame.payload.identity.executionId,
      );
      check(
        dispatch?.attempted &&
          sameExecution(dispatch.intent.assignment.identity, frame.payload.identity),
        "conflict",
        "Retained command execution changed",
      );
      const scope = {
        ...emptyScope(),
        agentIds: [dispatch.intent.reservation.agentId],
        conversationIds: [dispatch.intent.reservation.conversationId],
        workspaceIds: [dispatch.intent.reservation.workspaceId],
        tools: [dispatch.intent.assignment.tool],
        executorIds: [command.delivery.executorId],
      };
      requireGrant(liveCtx, "jobs.dispatch", scope);
      if (command.workspaceProofAction)
        requireGrant(liveCtx, command.workspaceProofAction, { ...scope, tools: [] });
      const executor = this.store.get<ExecutorState>("executor", command.delivery.executorId);
      if (
        !executor ||
        executor.status === "revoked" ||
        executor.generation !== command.delivery.generation ||
        !Number.isSafeInteger(command.delivery.connectionEpoch) ||
        command.delivery.connectionEpoch <= 0 ||
        executor.epoch !== command.delivery.connectionEpoch
      ) {
        // A superseded transport attempt cannot become current in the background.
        // Retain its receipt without futile alarms; a fresh authorized retry can
        // capture the replacement channel after revalidating the same command.
        this.store.put("command", key, command);
        return;
      }
      if (frame.type === "job.lease_update") {
        const retained = this.store.get<{ lease: D.Lease }>(
          "lease",
          frame.payload.identity.lease.leaseId,
        )?.lease;
        if (
          !retained ||
          retained.expiresAt <= Date.now() ||
          frame.payload.expiresAt <= Date.now()
        ) {
          this.store.put("command", key, command);
          return;
        }
        if (retained.leaseVersion > frame.payload.leaseVersion) {
          this.store.put("command", key, command);
          return;
        }
      }
      executors.send(command.delivery.executorId, command.delivery.generation, frame);
      this.store.put("command", key, command); // receipt retained; socket send is not a commit acknowledgment
    } catch {
      command.attempts = next(command.attempts);
      this.store.put(
        "command",
        key,
        command,
        "",
        "",
        Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(12, command.attempts)),
      );
    }
  }
  async receive(ctx: D.AuthContext, input: D.ExecutorDelivery): Promise<D.DeliveryAck> {
    const c = this.identities.current(ctx);
    const e = this.store.get<ExecutorState>("executor", input.executorId);
    check(
      c.role === "executor" &&
        Number.isSafeInteger(input.connectionEpoch) &&
        input.connectionEpoch !== undefined &&
        input.connectionEpoch > 0 &&
        c.executorId === input.executorId &&
        e &&
        e.epoch === input.connectionEpoch &&
        e.generation === input.generation &&
        e.status !== "revoked",
      "unauthenticated",
      "Stale executor delivery",
    );
    const frame = input.frame;
    let identity: D.ExecutionIdentity | undefined;
    let sequence = 0;
    let executionId: string | undefined;
    if (frame.type === "job.prepared_result") {
      identity = frame.payload.identity;
      sequence = frame.payload.sequence;
    } else if ("identity" in frame.payload) {
      identity = frame.payload.identity as D.ExecutionIdentity;
      if ("sequence" in frame.payload) sequence = frame.payload.sequence as number;
    }
    if (identity) {
      executionId = identity.executionId;
      const dispatch = this.store.get<DispatchRecord>("dispatch", identity.executionId);
      check(
        dispatch?.attempted &&
          sameExecution(dispatch.intent.assignment.identity, identity) &&
          identity.target.kind === "executor" &&
          identity.target.executorId === input.executorId,
        "conflict",
        "Unassigned execution delivery",
      );
      const owner = this.store.get<import("./identity.js").CredentialRecord>(
        "credential",
        identity.lease.credential.credentialId,
      );
      if (
        owner?.status !== "active" ||
        owner.generation !== identity.lease.credential.generation ||
        identity.target.generation !== input.generation
      ) {
        check(
          frame.type === "job.prepared_result",
          "unauthenticated",
          "Execution authority revoked",
        );
        const digest = await hash(json(frame.payload));
        check(
          new TextEncoder().encode(json(frame.payload)).length <= 65536,
          "payload_too_large",
          "Late result exceeds quarantine bound",
        );
        const key = `${identity.executionId}:${sequence}`;
        await this.store.arm();
        return this.store.tx(() => {
          this.identities.current(ctx);
          const publisher = this.store.get<ExecutorState>("executor", input.executorId);
          check(
            publisher &&
              publisher.generation === input.generation &&
              publisher.epoch === input.connectionEpoch &&
              publisher.status !== "revoked",
            "unauthenticated",
            "Artifact publisher changed before persistence",
          );
          const old = this.store.get<{ digest: string; ack: D.DeliveryAck }>("late_result", key);
          const delivered =
            this.store.get<{ digest: string; ack: D.DeliveryAck }>(
              "inbox",
              `${input.executorId}:${identity.executionId}:job.prepared_result:${sequence}`,
            ) ??
            this.store.get<{ digest: string; ack: D.DeliveryAck }>(
              "transport_receipt",
              `${input.executorId}:${identity.executionId}:job.prepared_result:${sequence}`,
            );
          if (delivered) {
            check(delivered.digest === digest, "conflict", "Late result sequence changed");
            return delivered.ack;
          }
          if (old) {
            check(old.digest === digest, "conflict", "Late result sequence changed");
            return old.ack;
          }
          check(
            this.store.page("late_result", 0, 4, { subject: identity.executionId }).length < 4,
            "quota_exceeded",
            "Late result quarantine exhausted",
          );
          const ack: D.DeliveryAck = { deliveryId: id(), sequence, persisted: true };
          // Preserve old-generation evidence without authorizing its byte source.
          if (identity.target.generation === input.generation)
            indexArtifacts(this.store, this.directory, frame.payload);
          this.store.put(
            "late_result",
            key,
            { result: frame.payload, digest, ack },
            identity.executionId,
          );
          return ack;
        });
      }
    }
    if (frame.type === "workspace.response") {
      const local = this.store.get<LocalTransport>("local_transport", frame.payload.correlationId);
      check(
        local &&
          local.requestId === frame.payload.requestId &&
          local.request.executorId === input.executorId &&
          local.request.executorGeneration === input.generation,
        "conflict",
        "Unrequested local response",
      );
    }
    const digest = await hash(json(frame.payload));
    const key = `${input.executorId}:${executionId ?? frame.requestId}:${frame.type}:${frame.type === "job.output" || frame.type === "job.prepared_result" ? sequence : frame.requestId}`;
    await this.store.arm();
    return this.store.tx(() => {
      this.identities.current(ctx);
      const currentExecutor = this.store.get<ExecutorState>("executor", input.executorId);
      check(
        currentExecutor &&
          currentExecutor.epoch === input.connectionEpoch &&
          currentExecutor.generation === input.generation &&
          currentExecutor.status !== "revoked",
        "unauthenticated",
        "Connection was superseded before persistence",
      );
      if (identity) {
        const owner = this.store.get<import("./identity.js").CredentialRecord>(
          "credential",
          identity.lease.credential.credentialId,
        );
        check(
          owner?.status === "active" && owner.generation === identity.lease.credential.generation,
          "unauthenticated",
          "Execution authority changed before persistence",
        );
      }
      const old =
        this.store.get<{ digest: string; ack: D.DeliveryAck }>("inbox", key) ??
        this.store.get<{ digest: string; ack: D.DeliveryAck }>("transport_receipt", key);
      if (old) {
        check(old.digest === digest, "conflict", "Delivery sequence reused with changed payload");
        return old.ack;
      }
      if (identity && frame.type === "job.output") {
        const bytes = new TextEncoder().encode(frame.payload.text).length;
        check(bytes <= 16384, "payload_too_large", "Output frame exceeded");
        const used =
          this.store.get<{ bytes: number }>("output_usage", identity.executionId)?.bytes ?? 0;
        check(
          used + bytes <= this.directory.policy().bounds.outputBytesPerJob,
          "quota_exceeded",
          "Execution output capacity exhausted",
        );
        this.store.put("output_usage", identity.executionId, { bytes: used + bytes });
      }
      if (frame.type === "job.prepared_result")
        indexArtifacts(this.store, this.directory, frame.payload);
      check(
        this.store.storage.sql
          .exec<{ n: number }>(
            "SELECT count(*) n FROM cp_records WHERE kind='inbox' AND due IS NOT NULL",
          )
          .one().n < 256,
        "quota_exceeded",
        "Receiver delivery window exhausted",
      );
      const ack: D.DeliveryAck = { deliveryId: id(), sequence, persisted: true };
      this.store.put(
        "inbox",
        key,
        {
          digest,
          ack,
          ctx,
          frame,
          ...(executionId ? { executionId } : {}),
          attempts: 0,
        } satisfies Inbox,
        "",
        "",
        Date.now(),
      );
      if (frame.type === "job.query_result" && identity) {
        const record = this.store.get<DispatchRecord>("dispatch", identity.executionId);
        if (record) {
          record.observation = frame.payload;
          this.store.put("dispatch", identity.executionId, record);
        }
      }
      if (frame.type === "job.cancel_ack" && identity) {
        const record = this.store.get<DispatchRecord>("dispatch", identity.executionId);
        if (record?.cancel) {
          record.cancel.disposition = frame.payload.disposition;
          this.store.put("dispatch", identity.executionId, record);
        }
      }
      if (frame.type === "workspace.response") {
        const local = this.store.get<LocalTransport>(
          "local_transport",
          frame.payload.correlationId,
        );
        check(local, "conflict", "Missing local request");
        local.response = frame.payload.response;
        this.store.put("local_transport", frame.payload.correlationId, local);
      }
      return ack;
    });
  }
  async drain(key: string): Promise<void> {
    const row = this.store.get<Inbox>("inbox", key);
    if (!row) return;
    const dispatch = row.executionId
      ? this.store.get<DispatchRecord>("dispatch", row.executionId)
      : undefined;
    let accepted = true;
    let failure: unknown;
    if (dispatch && (row.frame.type === "job.output" || row.frame.type === "job.prepared_result")) {
      accepted = false;
      try {
        const stub = this.env.AGENT_SESSIONS.getByName(dispatch.intent.reservation.agentId);
        check((await stub.contractVersion) === "1.0", "unsupported", "Agent contract mismatch");
        const original = this.store.get<import("./identity.js").CredentialRecord>(
          "credential",
          dispatch.intent.reservation.credential.credentialId,
        );
        check(original, "unauthenticated", "Missing execution owner");
        const ctx: D.AuthContext = {
          ...dispatch.intent.reservation.credential,
          principalId: original.principalId,
          role: original.role,
          deploymentId: this.identities.deploymentId,
          grants: original.grants,
          requestId: row.ack.deliveryId,
          authenticatedAt: Date.now(),
          credentialExpiresAt: original.expiresAt,
          deadline: Date.now() + 5000,
          registrationId: dispatch.intent.reservation.registrationIds.agent,
        };
        const frame = row.frame;
        const result = await within<D.Outcome<D.DeliveryAck>>(
          frame.type === "job.output"
            ? stub.receiveExecutorOutput(ctx, {
                ...frame.payload,
                deliveryId: row.ack.deliveryId,
              })
            : stub.receiveExecutorResult(ctx, {
                identity: frame.payload.identity,
                sequence: frame.payload.sequence,
                result: frame.payload,
                deliveryId: row.ack.deliveryId,
              }),
        );
        failure = result;
        accepted =
          result.ok &&
          result.value.persisted &&
          result.value.deliveryId === row.ack.deliveryId &&
          result.value.sequence === row.ack.sequence;
      } catch {}
    }
    this.store.tx(() => {
      const current = this.store.get<Inbox>("inbox", key);
      if (!current) return;
      check(current.digest === row.digest, "conflict", "Pending transport body changed");
      if (accepted) {
        if (row.frame.type !== "job.query_result")
          this.store.put("transport_receipt", key, { digest: row.digest, ack: row.ack });
        this.store.remove("inbox", key);
        repairAccepted(this.store, "inbox", key);
      } else {
        row.attempts = next(current.attempts);
        this.store.put(
          "inbox",
          key,
          row,
          "",
          "",
          Date.now() +
            Math.min(3600000, 1000 * 2 ** Math.min(12, row.attempts)) +
            Math.floor(Math.random() * 250),
        );
        postponeRepair(
          this.store,
          "inbox",
          key,
          failure,
          Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(12, row.attempts)),
        );
      }
    });
  }
  presence(key: string): void {
    this.store.tx(() => {
      const transition = this.store.get<{
        executorId: string;
        description: D.ExecutorDescription;
        cursor: number;
        cutoff: number;
      }>("presence_transition", key);
      if (!transition) return;
      const rows = this.store
        .page<D.AuthorityRegistration>("executor_recipient", transition.cursor, 16, {
          subject: `executor:${transition.executorId}`,
        })
        .filter((r) => r.seq <= transition.cutoff);
      for (const row of rows) {
        const registration = row.value;
        if (registration.recipient.kind === "agent")
          for (const conversationId of registration.resources.conversationIds) {
            const uniqueness = `${key}:${registration.recipient.id}:${conversationId}`;
            if (!this.store.get("presence_fact", uniqueness)) {
              const factId = id();
              const recipient = registration.recipient;
              const fact: D.Fact = {
                factId,
                source: recipient,
                recipients: [recipient],
                conversationId,
                createdAt: Date.now(),
                event: {
                  protocolVersion: "1.0",
                  schemaVersion: "1.0.0",
                  deploymentId: this.identities.deploymentId,
                  conversationId,
                  durability: "durable",
                  type: "executor.status.changed",
                  payload: transition.description,
                },
              };
              this.store.put(
                "fact",
                `${factId}:${recipient.kind}:${recipient.id}`,
                fact,
                "",
                `${recipient.kind}:${recipient.id}`,
                Date.now(),
              );
              this.store.put("presence_fact", uniqueness, { factId });
            }
          }
        transition.cursor = row.seq;
      }
      if (rows.length < 16) this.store.remove("presence_transition", key);
      else this.store.put("presence_transition", key, transition, "", "", Date.now() + 250);
    });
  }
  async drainFact(key: string): Promise<void> {
    const fact = this.store.get<D.Fact>("fact", key);
    if (!fact) return;
    const recipient = fact.recipients[0];
    let failure: unknown;
    if (recipient?.kind !== "agent") return;
    try {
      const stub = this.env.AGENT_SESSIONS.getByName(recipient.id);
      check((await stub.contractVersion) === "1.0", "unsupported", "Agent contract mismatch");
      const result = await within<D.Outcome<D.FactBatchAck>>(
        stub.ingestFacts(
          {
            kind: "fact-delivery",
            deploymentId: this.identities.deploymentId,
            source: fact.source,
            recipient,
            actions: ["ingest-facts"],
            deadline: Date.now() + 5000,
          },
          { facts: [fact], recipient },
        ),
      );
      failure = result;
      check(
        result.ok && result.value.acks.length === 1,
        "unavailable",
        "Fact acknowledgment unavailable",
      );
      const ack = result.value.acks[0];
      check(
        ack && ack.factId === fact.factId && same(ack.recipient, recipient) && ack.persisted,
        "conflict",
        "Fact acknowledgment scope mismatch",
      );
      this.acceptFactAck(ack);
    } catch {
      this.store.tx(() => {
        if (!this.store.get<D.Fact>("fact", key)) return;
        const attempts = next(
          this.store.get<{ attempts: number }>("fact_retry", key)?.attempts ?? 0,
        );
        this.store.put("fact_retry", key, { attempts });
        this.store.put(
          "fact",
          key,
          fact,
          "",
          `${recipient.kind}:${recipient.id}`,
          Date.now() +
            Math.min(3600000, 1000 * 2 ** Math.min(12, attempts)) +
            Math.floor(Math.random() * 250),
        );
        postponeRepair(
          this.store,
          "fact",
          key,
          failure,
          Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(12, attempts)),
        );
      });
    }
  }
  page(ctx: D.AuthContext, input: D.FactPageRequest): D.FactPage {
    this.identities.current(ctx);
    requireGrant(ctx, "facts.read", {
      ...emptyScope(),
      ...(input.recipient.kind === "agent"
        ? { agentIds: [input.recipient.id] }
        : { workspaceIds: [input.recipient.id] }),
    });
    check(input.limit >= 1 && input.limit <= 100, "invalid_request", "Invalid fact page");
    const view = `facts:${input.recipient.kind}:${input.recipient.id}`;
    const after = this.directory.cursor(ctx, view, input.after);
    const rows = this.store.page<D.Fact>("fact", after, input.limit, {
      recipient: `${input.recipient.kind}:${input.recipient.id}`,
    });
    return {
      items: rows.map((r) => r.value),
      ...(rows.length === input.limit
        ? { nextPageToken: this.directory.token(ctx, view, rows.at(-1)?.seq ?? after) }
        : {}),
    };
  }
  ack(ctx: D.AuthContext, input: D.FactAckRequest): D.FactAck {
    this.identities.current(ctx);
    requireGrant(ctx, "facts.ack", {
      ...emptyScope(),
      ...(input.recipient.kind === "agent"
        ? { agentIds: [input.recipient.id] }
        : { workspaceIds: [input.recipient.id] }),
    });
    return this.acceptFactAck(input);
  }
  private acceptFactAck(input: D.FactAckRequest): D.FactAck {
    check(
      Number.isSafeInteger(input.eventSeq) && input.eventSeq > 0,
      "invalid_request",
      "Invalid assigned event coordinate",
    );
    const key = `${input.factId}:${input.recipient.kind}:${input.recipient.id}`;
    return this.store.tx(() => {
      const prior = this.store.get<D.FactAck>("fact_ack", key);
      if (prior) {
        check(
          same({ ...input, persisted: true }, prior),
          "conflict",
          "Fact acknowledgment changed",
        );
        return prior;
      }
      const fact = this.store.get<D.Fact>("fact", key);
      check(
        fact?.recipients.some((r) => same(r, input.recipient)),
        "not_found",
        "Fact unavailable",
      );
      const ack = { ...input, persisted: true as const };
      this.store.put("fact_ack", key, ack);
      this.store.remove("fact", key);
      this.store.remove("fact_retry", key);
      repairAccepted(this.store, "fact", key);
      return ack;
    });
  }
}

function isProtocolError(value: unknown): value is D.ProtocolError {
  return valid("common", "ProtocolError", value);
}
async function boundedProof(
  response: Response,
  deadline: number,
  current: () => unknown,
): Promise<unknown> {
  const reader = response.body?.getReader();
  check(reader, "conflict", "Terminal proof body missing");
  const bytes = new Uint8Array(65536);
  let offset = 0;
  try {
    for (;;) {
      const part = await within(reader.read(), Math.max(1, deadline - Date.now()));
      current();
      if (part.done) break;
      check(
        Date.now() < deadline && offset + part.value.length <= bytes.length,
        "payload_too_large",
        "Terminal proof bound exceeded",
      );
      bytes.set(part.value, offset);
      offset += part.value.length;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes.subarray(0, offset),
        ),
      );
    } catch {
      fail("conflict", "Invalid terminal proof");
    }
  } finally {
    await within(reader.cancel(), Math.max(1, deadline - Date.now())).catch(() => undefined);
  }
}
