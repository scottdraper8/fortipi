import { publicCommitReceipt } from "fortipi-contract";
import type { AgentSessionRpc } from "../boundary/agent-session.js";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { emptyScope, requireGrant } from "./authorization.js";
import { type Directory, valid } from "./directory.js";
import { type DispatchRecord, sameExecution } from "./dispatch.js";
import type { Executors } from "./executors.js";
import type { Identities } from "./identity.js";
import { postponeRepair, repairAccepted } from "./repair.js";
import { check, hash, id, json, next, type Store, same, within } from "./store.js";
import type { ExecutorState } from "./tickets.js";

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
  delivery: D.ExecutorDelivery;
  ack: D.DeliveryAck;
  digest: string;
  attempts: number;
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
  constructor(store: Store, identities: Identities, directory: Directory, env: Env) {
    this.store = store;
    this.identities = identities;
    this.directory = directory;
    this.env = env;
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
        identity.assignmentDigest === record.receipt.assignmentDigest &&
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
    };
    requireGrant(ctx, "jobs.dispatch", resources);
    if (frame.type === "job.lease_update") {
      const old = record.intent.assignment.identity.lease;
      check(
        old.leaseId === identity.lease.leaseId &&
          old.fence === identity.lease.fence &&
          old.baseRevision === identity.lease.baseRevision &&
          same(old.credential, identity.lease.credential) &&
          old.expiresAt > Date.now() &&
          frame.payload.leaseVersion > old.leaseVersion &&
          frame.payload.expiresAt > Date.now() &&
          frame.payload.expiresAt <= identity.deadline,
        "conflict",
        "Lease update cannot change identity or revive expiry",
      );
      this.store.put("lease", old.leaseId, {
        lease: {
          ...old,
          leaseVersion: frame.payload.leaseVersion,
          expiresAt: frame.payload.expiresAt,
        },
      });
    } else {
      check(
        frame.payload.terminalVersion > 0 && frame.payload.eventSeq > 0,
        "conflict",
        "Terminal coordinates are required",
      );
      const workspace = this.env.WORKSPACES.getByName(record.intent.reservation.workspaceId);
      check(
        (await workspace.contractVersion) === "1.0",
        "unsupported",
        "Workspace contract mismatch",
      );
      if (frame.payload.evidence.kind === "committed") {
        const receipt = frame.payload.evidence.receipt;
        const found = await workspace.getReceipt(ctx, {
          workspaceId: receipt.workspaceId,
          commitId: receipt.commitId,
          commitDigest: receipt.commitDigest,
        });
        check(
          found.ok && same(publicCommitReceipt(found.value), receipt),
          "conflict",
          "Commit evidence is not authoritative",
        );
      } else {
        const evidence = frame.payload.evidence;
        const found = await workspace.manifest(ctx, {
          operationId: "getWorkspaceManifest",
          path: { workspaceId: evidence.workspaceId },
          query: { revision: evidence.baseRevision },
          body: undefined,
        });
        check(
          found.ok &&
            found.value.status === 200 &&
            found.value.body.manifestHash === evidence.manifestHash &&
            evidence.baseRevision === identity.baseRevision,
          "conflict",
          "Unchanged-base evidence is not authoritative",
        );
      }
      const agent = this.env.AGENT_SESSIONS.getByName(record.intent.reservation.agentId);
      check((await agent.contractVersion) === "1.0", "unsupported", "Agent contract mismatch");
      const registered = {
        ...ctx,
        registrationId: record.intent.reservation.registrationIds.agent,
      };
      const job = await agent.describeJob(registered, {
        operationId: "describeJob",
        path: { id: identity.jobId },
        query: {},
        body: undefined,
      });
      check(
        job.ok &&
          job.value.status === 200 &&
          job.value.body.state === "completed" &&
          job.value.body.version === frame.payload.terminalVersion &&
          same(job.value.body.evidence, frame.payload.evidence),
        "conflict",
        "Job terminal evidence does not match",
      );
      // The platform mapped generic expands all operation unions past TS's depth limit.
      // Reuse the declared boundary signature; validate the actual reply below.
      const api = agent as unknown as Pick<AgentSessionRpc, "handleApi">;
      const raw = await api.handleApi(registered, {
        operationId: "replayEvents",
        path: { id: record.intent.reservation.conversationId },
        query: { after: frame.payload.eventSeq - 1, through: frame.payload.eventSeq, limit: 1 },
        body: undefined,
      });
      const events = raw as D.Outcome<{ status: number; body: unknown }>;
      check(
        events.ok &&
          events.value.status === 200 &&
          valid("conversations", "ReplayPage", events.value.body),
        "conflict",
        "Terminal event coordinate is not persisted",
      );
      const page = events.value.body as D.ReplayPage;
      check(
        page.events.some(
          (event) =>
            event.eventSeq === frame.payload.eventSeq &&
            event.type === "job.state.changed" &&
            typeof event.payload === "object" &&
            event.payload !== null &&
            "jobId" in event.payload &&
            event.payload.jobId === identity.jobId,
        ),
        "conflict",
        "Terminal event does not identify the job",
      );
    }
    const digest = await hash(json(frame.payload));
    const key = `${identity.executionId}:${frame.type}:${frame.type === "job.committed" ? frame.payload.terminalVersion : frame.payload.leaseVersion}`;
    await this.store.arm();
    const command = this.store.tx(() => {
      this.identities.current(ctx);
      const old = this.store.get<Command>("command", key);
      if (old) {
        check(old.digest === digest, "conflict", "Authority command changed");
        return old;
      }
      const command: Command = {
        ctx,
        delivery: input,
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
      this.identities.current({ ...command.ctx, deadline: Date.now() + 5000 });
      const frame = command.delivery.frame;
      if (frame.type === "job.lease_update")
        check(frame.payload.expiresAt > Date.now(), "conflict", "Lease update expired");
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
          const old = this.store.get<{ digest: string; ack: D.DeliveryAck }>("late_result", key);
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
        check(
          new TextEncoder().encode(frame.payload.output.tail).length <=
            this.directory.policy().bounds.inlineTailBytes &&
            frame.payload.output.artifacts.reduce((sum, artifact) => sum + artifact.size, 0) <=
              this.directory.policy().bounds.artifactBytes,
          "payload_too_large",
          "Prepared result exceeds effective output bounds",
        );
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
