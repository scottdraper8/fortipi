import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  Assignment,
  ErrorBody,
  ExecutionIdentity,
  ExecutionObservation,
  ExecutorFrame,
  JobCommitted,
  LeaseUpdate,
  LocalWorkspaceResponse,
  PreparedResult,
  TransferDescriptor,
} from "fortipi-contract/executor";
import { canonicalJson, validateAssignment } from "fortipi-contract/executor";
import { Approvals } from "./approval.js";
import type { Binding, Profile } from "./config.js";
import { adapter, effectiveLimits, secureDirectory, stateHome } from "./config.js";
import type { JobRow } from "./ledger.js";
import { Guard, Ledger, ledgerRegistryIdentity, rootRegistry } from "./ledger.js";
import { Output } from "./output.js";
import type { PlatformAdapter } from "./platform/types.js";
import { childEnvironment } from "./platform/types.js";
import { allowedByRule, approvalKey, checkPolicy, hash, immutableIdentity } from "./policy.js";
import type { FrameHandler } from "./transport.js";
import { frame, HttpTransport, SessionTransport } from "./transport.js";
import { LocalWorkspace } from "./workspace/local.js";
import { SafeRoot } from "./workspace/paths.js";
import { Snapshots } from "./workspace/snapshot.js";
import { Staging } from "./workspace/staging.js";

export interface RuntimeOptions {
  profile: Profile;
  ledger: Ledger;
  directory: string;
  platform?: PlatformAdapter;
  http?: HttpTransport;
  roots: Map<string, SafeRoot>;
  reloadProfile?: () => Promise<Profile>;
}
export class ExecutorRuntime implements FrameHandler {
  profile: Profile;
  ledger: Ledger;
  directory: string;
  platform: PlatformAdapter;
  http: HttpTransport;
  roots: Map<string, SafeRoot>;
  locals = new Map<string, LocalWorkspace>();
  staging: Staging;
  snapshots: Snapshots;
  approvals: Approvals;
  children = new Map<string, ChildProcess>();
  active = new Set<string>();
  transfers = new Set<string>();
  stageRetryAt = new Map<string, number>();
  queryIndex = 0;
  private workspaceRequests = new Map<string, Promise<LocalWorkspaceResponse | ErrorBody>>();
  connected = false;
  revoked = false;
  session?: SessionTransport;
  reloadProfile?: () => Promise<Profile>;
  constructor(options: RuntimeOptions) {
    this.profile = options.profile;
    this.ledger = options.ledger;
    this.directory = options.directory;
    this.platform = options.platform ?? adapter();
    this.http = options.http ?? new HttpTransport(options.profile);
    this.http.bindLedger(this.ledger);
    this.roots = options.roots;
    this.approvals = new Approvals(this.ledger);
    if (options.reloadProfile) this.reloadProfile = options.reloadProfile;
    this.staging = new Staging(join(this.directory, "staging"), this.ledger, this.http);
    this.snapshots = new Snapshots(
      join(this.directory, "scratch"),
      this.ledger,
      this.http,
      this.platform,
    );
    for (const binding of this.profile.bindings) {
      const root = this.roots.get(binding.rootBindingId);
      if (root) {
        const key = `root_${binding.rootBindingId}`;
        const saved = this.ledger.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
          | { value: string }
          | undefined;
        if (saved && saved.value !== root.key)
          throw new Error("registered root was replaced; explicit recovery required");
        this.ledger.db.prepare("INSERT OR IGNORE INTO meta VALUES (?,?)").run(key, root.key);
      }
      if (root && binding.providerKind === "local")
        this.locals.set(
          binding.rootBindingId,
          new LocalWorkspace(root, binding, this.profile, this.ledger, this.staging),
        );
    }
  }
  async initialize(): Promise<void> {
    await this.staging.initialize();
    await secureDirectory(join(this.directory, "artifacts"), this.platform);
  }
  identityAllowed(identity: ExecutionIdentity, allowRevoked = false): void {
    const p = this.profile,
      l = identity.lease;
    if (
      (this.revoked && !allowRevoked) ||
      identity.target.kind !== "executor" ||
      identity.target.executorId !== p.executorId ||
      identity.target.generation !== p.executorGeneration ||
      l.executorId !== p.executorId ||
      l.executorGeneration !== p.executorGeneration ||
      l.ownerKind !== "job" ||
      l.jobId !== identity.jobId ||
      l.baseRevision !== identity.baseRevision
    )
      throw new Error("executor execution authority mismatch");
  }
  binding(assignment: Assignment, requireBase = true): Binding {
    const binding = this.profile.bindings.find(
      (b) =>
        b.workspaceId === assignment.workspaceId &&
        b.bindingVersion === assignment.bindingVersion &&
        (assignment.rootBindingId === undefined || b.rootBindingId === assignment.rootBindingId),
    );
    if (
      !binding ||
      assignment.identity.lease.workspaceId !== binding.workspaceId ||
      !this.profile.resources.workspaceIds.includes(binding.workspaceId) ||
      !this.profile.resources.tools.includes(assignment.tool)
    )
      throw new Error("assignment binding/grant mismatch");
    if (
      requireBase &&
      binding.providerKind === "local" &&
      (!assignment.rootBindingId || assignment.identity.baseRevision !== binding.revision)
    )
      throw new Error("local binding base mismatch");
    return binding;
  }
  private async currentPolicy(): Promise<void> {
    if (!this.reloadProfile) return;
    const p = await this.reloadProfile();
    if (
      p.executorId !== this.profile.executorId ||
      p.deploymentId !== this.profile.deploymentId ||
      p.ledgerId !== this.profile.ledgerId ||
      p.executorGeneration !== this.profile.executorGeneration ||
      canonicalJson(p.credential) !== canonicalJson(this.profile.credential) ||
      p.origin !== this.profile.origin ||
      canonicalJson(p.resources) !== canonicalJson(this.profile.resources) ||
      canonicalJson(p.limits) !== canonicalJson(this.profile.limits) ||
      canonicalJson(p.bindings.map((b) => [b.rootBindingId, b.path, b.bindingVersion])) !==
        canonicalJson(this.profile.bindings.map((b) => [b.rootBindingId, b.path, b.bindingVersion]))
    )
      throw new Error("profile identity changed; restart and reconcile");
    this.profile.policy = p.policy;
  }
  async assignOnce(assignment: Assignment): Promise<ExecutionObservation> {
    this.http.assertExecutorAuthority();
    frame({ type: "job.assign", requestId: randomUUID(), payload: assignment });
    this.identityAllowed(assignment.identity);
    await validateAssignment(assignment);
    if (
      assignment.operationContext.deploymentId !== this.profile.deploymentId ||
      !this.profile.resources.agentIds.includes(assignment.operationContext.agentId) ||
      !this.profile.resources.conversationIds.includes(assignment.operationContext.conversationId)
    )
      throw new Error("assignment operation context outside local resource policy");
    const binding = this.binding(assignment);
    const root = this.roots.get(binding.rootBindingId);
    if (!root) throw new Error("binding root unavailable");
    await this.currentPolicy();
    const closed = this.ledger.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get(`closed_${assignment.identity.jobId}`) as { value: string } | undefined;
    if (closed) {
      if (closed.value !== immutableIdentity(assignment.identity))
        throw new Error("closed attempt identity conflict");
      return this.queryExisting(assignment.identity);
    }
    const old = this.ledger.get(assignment.identity.jobId);
    if (!old && this.ledger.pending().length >= this.http.limits.queuedAdmissions)
      throw new Error("local approval queue at capacity");
    const key = approvalKey(assignment, this.profile.policy, root.key);
    const row = this.ledger.admit(assignment, key);
    if (row.state !== "pending") return this.queryExisting(assignment.identity);
    try {
      checkPolicy(assignment, this.profile.policy, Date.now());
    } catch (error) {
      row.state = "closed";
      row.decision = "deny";
      row.reason = error instanceof Error ? error.message : "local policy rejected";
      this.ledger.put(row);
      return this.queryExisting(assignment.identity);
    }
    if (allowedByRule(assignment, this.profile.policy) && row.decision === "pending") {
      row.decision = "allow";
      this.ledger.put(row);
    }
    if (row.decision === "pending" && assignment.approval)
      this.session?.send({
        type: "local_policy.pending",
        requestId: randomUUID(),
        payload: { identity: assignment.identity, operation: assignment.approval },
      });
    if (row.decision === "allow") await this.start(row);
    return this.queryExisting(assignment.identity);
  }
  queryExisting(identity: ExecutionIdentity): ExecutionObservation {
    this.identityAllowed(identity);
    const row = this.ledger.existing(identity);
    if (!row) {
      const closed = this.ledger.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get(`closed_${identity.jobId}`) as { value: string } | undefined;
      if (closed && closed.value !== immutableIdentity(identity))
        throw new Error("closed attempt identity conflict");
      if (closed?.value === immutableIdentity(identity))
        return {
          identity,
          state: "not_started",
          proof: {
            kind: "durable-no-late-start",
            ledgerVersion: 1,
            closedAssignmentDigest: identity.assignmentDigest,
          },
        };
      return { identity, state: "unknown" };
    }
    if (row.state === "closed" && !row.result)
      return {
        identity: row.assignment.identity,
        state: "not_started",
        proof: {
          kind: "durable-no-late-start",
          ledgerVersion: 1,
          closedAssignmentDigest: identity.assignmentDigest,
        },
      };
    if (row.result)
      return {
        identity: row.assignment.identity,
        state: row.committed ? "terminal" : "pending_sync",
        result: row.result,
      };
    return {
      identity: row.assignment.identity,
      state:
        row.state === "running" &&
        this.children.get(identity.jobId)?.exitCode === null &&
        this.children.get(identity.jobId)?.signalCode === null
          ? "running"
          : "unknown",
      ...(row.backendExecutionId
        ? { backendExecutionId: row.backendExecutionId, runtimeUuid: row.incarnation }
        : {}),
    };
  }
  async start(row: JobRow): Promise<void> {
    const assignment = row.assignment,
      id = assignment.identity;
    if (
      this.active.has(id.jobId) ||
      row.state !== "pending" ||
      row.incarnation !== this.ledger.incarnation
    )
      return;
    if (!this.connected || this.revoked || this.active.size >= this.http.limits.activeMutatingJobs)
      return;
    if (this.http.pressureHeld || Date.now() < this.http.pausedUntil) return;
    this.active.add(id.jobId);
    let root: SafeRoot | undefined;
    try {
      await this.currentPolicy();
      this.identityAllowed(id);
      checkPolicy(assignment, this.profile.policy, Date.now());
      const binding = this.binding(assignment),
        registeredRoot = this.roots.get(binding.rootBindingId);
      if (!registeredRoot) throw new Error("root unavailable");
      if (approvalKey(assignment, this.profile.policy, registeredRoot.key) !== row.approvalKey)
        throw new Error("local approval expired by context change");
      root =
        binding.providerKind === "computer"
          ? await this.snapshots.materialize(assignment)
          : registeredRoot;
      await root.verify();
      if (binding.providerKind === "local") {
        const local = this.locals.get(binding.rootBindingId);
        if (!local) throw new Error("local provider unavailable");
        await local.serialized(() => local.nativeIntent(assignment));
      }
      const envArgument = assignment.arguments.env;
      if (
        envArgument !== undefined &&
        (typeof envArgument !== "object" ||
          envArgument === null ||
          Array.isArray(envArgument) ||
          Object.values(envArgument).some((v) => typeof v !== "string"))
      )
        throw new Error("invalid child environment");
      let cwd = root.identity.path;
      const requestedCwd = assignment.arguments.cwd;
      if (requestedCwd !== undefined) {
        if (typeof requestedCwd !== "string" || !(await root.stat(requestedCwd)).isDirectory())
          throw new Error("invalid cwd");
        cwd = root.native(requestedCwd);
      }
      const spec = this.platform.shell(
        assignment.arguments.command as string,
        cwd,
        childEnvironment(envArgument as Record<string, string> | undefined),
      );
      await this.currentPolicy();
      await root.verify();
      const currentLease = this.ledger.get(id.jobId)?.assignment.identity.lease;
      if (!currentLease) throw new Error("execution ledger lost before claim");
      id.lease = currentLease;
      this.http.assertExecutorAuthority();
      if (binding.providerKind === "local") {
        const local = this.locals.get(binding.rootBindingId),
          journal = this.ledger.local(id.lease.operationId);
        if (!local || !journal) throw new Error("native local journal missing");
        local.authorize({ ...journal.request, lease: currentLease });
      }
      this.identityAllowed(id);
      checkPolicy(assignment, this.profile.policy, Date.now());
      if (
        !this.connected ||
        approvalKey(assignment, this.profile.policy, registeredRoot.key) !== row.approvalKey
      )
        throw new Error("approval context changed before start");
      // No await between the winning FULL SQLite commit and spawn.
      if (
        !this.ledger.claim(
          id.jobId,
          row.approvalKey,
          root.key,
          binding.providerKind === "local" ? id.lease.operationId : id.jobId,
        )
      ) {
        this.active.delete(id.jobId);
        return;
      }
      const child = this.platform.spawn(spec);
      this.children.set(id.jobId, child);
      const fresh = this.ledger.get(id.jobId);
      if (!fresh) throw new Error("start ledger disappeared");
      fresh.state = "running";
      fresh.backendExecutionId = randomUUID();
      this.ledger.put(fresh);
      const output = new Output(this.ledger, id, this.http.limits, this.http.outputFrameBytes);
      let outputFailed = false;
      for (const stream of ["stdout", "stderr"] as const)
        child[stream]?.on("data", (data: Buffer) => {
          try {
            output.append(stream, data);
          } catch {
            outputFailed = true;
            child.stdout?.destroy();
            child.stderr?.destroy();
            void this.cancel(id, "output storage failure").catch(() => {});
          }
        });
      let spawnError = false;
      child.once("error", () => {
        spawnError = true;
      });
      const executionRoot = root;
      child.once("close", (code, signal) => {
        void this.finished(
          assignment,
          executionRoot,
          output,
          code,
          signal,
          spawnError,
          outputFailed,
        )
          .catch(() => {
            const failed = this.ledger.get(id.jobId);
            if (failed) {
              failed.state = "unknown";
              failed.reason = "result recovery requires reconciliation";
              this.ledger.put(failed);
            }
            this.ledger.quarantine(executionRoot.key);
          })
          .finally(() => {
            this.children.delete(id.jobId);
            this.active.delete(id.jobId);
          });
      });
    } catch (error) {
      this.active.delete(id.jobId);
      const current = this.ledger.get(id.jobId);
      if (current && current.state === "pending") {
        current.state = "closed";
        current.decision = "deny";
        current.reason = error instanceof Error ? error.message : "start rejected";
        this.ledger.put(current);
      } else if (current && !current.result && !this.children.has(id.jobId)) {
        current.state = "unknown";
        this.ledger.put(current);
        if (root) this.ledger.quarantine(root.key);
      }
      throw error;
    }
  }
  private async finished(
    assignment: Assignment,
    root: SafeRoot,
    output: Output,
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnError: boolean,
    outputFailed: boolean,
  ): Promise<void> {
    output.finish();
    const id = assignment.identity,
      binding = this.binding(assignment),
      row = this.ledger.get(id.jobId);
    if (!row) throw new Error("result ledger lost");
    assignment = row.assignment;
    const stale = this.leaseLost(row.assignment) || this.revoked;
    const certain =
      !outputFailed && row.state !== "unknown" && (code !== null || signal !== null || spawnError);
    let result = await output.result(
      !certain || stale
        ? "unknown"
        : row.cancelled
          ? "cancelled"
          : code === 0
            ? "succeeded"
            : "failed",
      join(this.directory, "artifacts"),
      !spawnError,
    );
    if (binding.providerKind === "local") {
      const local = this.locals.get(binding.rootBindingId);
      if (!local) throw new Error("local journal unavailable");
      const observation = await local.nativeFinished(assignment, certain && !stale);
      result = {
        ...result,
        commitId: observation.commitId,
        ...(observation.postManifestHash ? { manifestHash: observation.postManifestHash } : {}),
      };
      if (observation.state !== "applied") result.state = "unknown";
    } else {
      const diff = await this.snapshots.diff(assignment, root);
      if (diff.changes.length === 0) result = { ...result, manifestHash: diff.after.manifestHash };
      else if (!stale && certain) {
        this.ledger.saveRecord("stages", `execution_outcome_${id.executionId}`, {
          state: result.state,
          possibleExternalEffects: result.possibleExternalEffects,
        });
        try {
          const staged = await this.snapshots.stage(assignment, root, randomUUID(), randomUUID());
          result = {
            ...result,
            uploadId: staged.uploadId,
            commitId: staged.commitId,
            manifestHash: staged.manifestHash,
          };
        } catch {
          const intent = this.ledger.record<{ commitId: string }>(
              "stages",
              `upload_intent_${id.executionId}`,
            ),
            open = this.ledger.record<{ uploadId: string }>(
              "stages",
              `upload_open_${id.executionId}`,
            );
          result = {
            ...result,
            state: "unknown",
            manifestHash: diff.after.manifestHash,
            ...(intent ? { commitId: intent.commitId } : {}),
            ...(open ? { uploadId: open.uploadId } : {}),
          };
        }
      } else {
        result = { ...result, state: "unknown", manifestHash: diff.after.manifestHash };
        this.ledger.quarantine(root.key);
      }
    }
    // Publish only the final prepared result; transport delivery is independent of terminal success.
    this.ledger.transaction(() => {
      const latest = this.ledger.get(id.jobId);
      if (!latest) throw new Error("result missing");
      latest.result = result;
      latest.state = "result";
      latest.sequence = result.sequence;
      this.ledger.put(latest);
      this.ledger.enqueue(id.jobId, "result", result.sequence, {
        type: "job.prepared_result",
        requestId: randomUUID(),
        payload: result,
      });
    });
    this.flush();
  }
  collectResult(identity: ExecutionIdentity): PreparedResult {
    this.identityAllowed(identity);
    const row = this.ledger.existing(identity);
    if (!row?.result) throw new Error("result not available");
    return row.result;
  }
  async cancel(
    identity: ExecutionIdentity,
    _reason: string,
  ): Promise<Extract<ExecutorFrame, { type: "job.cancel_ack" }>["payload"]["disposition"]> {
    this.identityAllowed(identity, true);
    let row = this.ledger.existing(identity);
    if (!row) {
      const old = this.ledger.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get(`closed_${identity.jobId}`) as { value: string } | undefined;
      if (old && old.value !== immutableIdentity(identity))
        throw new Error("closed cancel identity conflict");
      this.ledger.transaction(() =>
        this.ledger.db
          .prepare("INSERT OR IGNORE INTO meta VALUES (?,?)")
          .run(`closed_${identity.jobId}`, immutableIdentity(identity)),
      );
      return { state: "not-started", possibleExternalEffects: false };
    }
    if (row.committed || row.result)
      return {
        state: "already-terminal",
        possibleExternalEffects: row.result?.possibleExternalEffects ?? true,
      };
    this.ledger.transaction(() => {
      row = this.ledger.existing(identity);
      if (!row) throw new Error("cancel ledger missing");
      row.cancelled = true;
      if (row.state === "pending") {
        row.state = "closed";
        row.decision = "deny";
      }
      this.ledger.put(row);
    });
    if (row.state === "closed") return { state: "not-started", possibleExternalEffects: false };
    const child = this.children.get(identity.jobId);
    const disposition = child
      ? await this.platform.cancel(child, 250)
      : { state: "unknown" as const, possibleExternalEffects: true };
    if (disposition.state === "unknown") {
      this.ledger.transaction(() => {
        const latest = this.ledger.existing(identity);
        if (latest && !latest.committed && !latest.result) {
          latest.state = "unknown";
          latest.reason = "cancellation cannot confirm process-tree exit";
          this.ledger.put(latest);
        }
        this.ledger.db
          .prepare("UPDATE pins SET quarantine=1 WHERE operation IN (?,?)")
          .run(identity.jobId, identity.lease.operationId);
      });
    }
    return disposition;
  }
  leaseUpdate(update: LeaseUpdate): void {
    this.identityAllowed(update.identity);
    const row = this.ledger.existing(update.identity);
    if (!row) throw new Error("unknown lease attempt");
    const lease = row.assignment.identity.lease;
    if (update.leaseVersion === lease.leaseVersion && update.expiresAt === lease.expiresAt) return;
    if (update.leaseVersion < lease.leaseVersion) return;
    if (
      Date.now() >= lease.expiresAt ||
      update.leaseVersion <= lease.leaseVersion ||
      update.expiresAt <= lease.expiresAt ||
      update.expiresAt > row.assignment.identity.deadline
    )
      throw new Error("lease cannot revive/change identity");
    lease.expiresAt = update.expiresAt;
    lease.leaseVersion = update.leaseVersion;
    this.ledger.transaction(() => {
      this.ledger.put(row);
      const local = this.ledger.local(lease.operationId);
      if (local) {
        local.request.lease.expiresAt = update.expiresAt;
        local.request.lease.leaseVersion = update.leaseVersion;
        local.prepared.expiresAt = Math.min(update.expiresAt, local.request.deadline);
        this.ledger.saveLocal(local);
      }
    });
  }
  async committed(value: JobCommitted): Promise<void> {
    this.identityAllowed(value.identity);
    const row = this.ledger.existing(value.identity);
    if (!row?.result) throw new Error("terminal acknowledgment without result");
    if (row.committed) {
      if (canonicalJson(row.committed) !== canonicalJson(value))
        throw new Error("conflicting terminal acknowledgment");
      return;
    }
    const binding = this.binding(row.assignment, false);
    if (value.evidence.kind === "committed") {
      const receipt = value.evidence.receipt;
      if (
        receipt.providerKind !== binding.providerKind ||
        receipt.jobId !== value.identity.jobId ||
        receipt.workspaceId !== row.assignment.workspaceId ||
        receipt.operationId !== value.identity.lease.operationId ||
        receipt.baseRevision !== value.identity.baseRevision ||
        receipt.manifestHash !== row.result.manifestHash ||
        receipt.commitId !== row.result.commitId
      )
        throw new Error("terminal receipt mismatch");
      if (receipt.providerKind === "computer") {
        const stage = this.ledger.record<{
          stageId: string;
          uploadId: string;
          manifestHash: string;
        }>("stages", `upload_ready_${value.identity.executionId}`);
        if (
          !stage ||
          stage.stageId !== receipt.storeRef.stageId ||
          stage.uploadId !== row.result.uploadId ||
          stage.manifestHash !== receipt.manifestHash
        )
          throw new Error("terminal public stage mismatch");
      }
      if (receipt.providerKind === "local") {
        const local = this.ledger.local(value.identity.lease.operationId);
        if (
          !local?.observation.receipt ||
          canonicalJson(local.observation.receipt) !== canonicalJson(receipt)
        )
          throw new Error("local receipt acknowledgment still pending");
      }
    } else if (
      value.evidence.executionId !== value.identity.executionId ||
      value.evidence.workspaceId !== row.assignment.workspaceId ||
      value.evidence.baseRevision !== value.identity.baseRevision ||
      value.evidence.manifestHash !== row.result.manifestHash ||
      row.result.uploadId
    )
      throw new Error("unchanged evidence mismatch");
    const root = this.roots.get(binding.rootBindingId);
    if (value.evidence.kind === "verified-unchanged" && binding.providerKind === "local") {
      const local = this.ledger.local(value.identity.lease.operationId),
        provider = this.locals.get(binding.rootBindingId);
      if (
        !local ||
        !provider ||
        local.observation.state !== "applied" ||
        local.observation.preManifestHash !== value.evidence.manifestHash ||
        local.observation.postManifestHash !== value.evidence.manifestHash
      )
        throw new Error("unchanged local evidence missing");
      const { kind: _kind, mode: _mode, expectedManifestHash: _hash, ...scope } = local.request;
      const observation = await provider.request({
        ...scope,
        kind: "observe",
        preparationId: local.prepared.preparationId,
      });
      if (!("state" in observation) || observation.state !== "applied")
        throw new Error("local unchanged bytes drifted");
    }
    this.ledger.transaction(() => {
      row.committed = value;
      row.state = "closed";
      this.ledger.put(row);
      if (binding.providerKind === "computer")
        this.ledger.db
          .prepare("INSERT OR IGNORE INTO meta VALUES (?,?)")
          .run(`cleanup_pending_${value.identity.jobId}`, value.identity.jobId);
      if (root && value.evidence.kind === "verified-unchanged")
        this.ledger.release(
          root.key,
          binding.providerKind === "local"
            ? value.identity.lease.operationId
            : value.identity.jobId,
        );
    });
    if (binding.providerKind === "computer" && row.result.manifestHash)
      await this.snapshots.cleanup(row.assignment, row.result.manifestHash).catch(() => {});
  }
  flush(): void {
    if (this.session) for (const pending of this.ledger.outbox()) this.session.send(pending);
  }
  reconnectFrames(): ExecutorFrame[] {
    const identities = this.ledger.identities().slice(this.queryIndex, this.queryIndex + 32);
    this.queryIndex += identities.length;
    return [
      ...identities.map(
        (identity): ExecutorFrame => ({
          type: "job.query",
          requestId: randomUUID(),
          payload: identity,
        }),
      ),
      ...this.ledger.outbox(),
    ];
  }
  async disconnected(): Promise<void> {
    this.connected = false;
  }
  async receive(value: ExecutorFrame): Promise<void> {
    if (Buffer.byteLength(canonicalJson(value)) > this.http.jsonBytes)
      throw new Error("payload_too_large: encoded frame");
    frame(value);
    this.http.assertExecutorAuthority();
    if (value.type === "executor.registered") {
      this.connected = true;
      this.queryIndex = 0;
      Object.assign(this.ledger.limits, effectiveLimits(this.ledger.limits, this.http.limits));
      this.staging.limits = this.http.limits;
      this.snapshots.limits = this.http.limits;
      for (const local of this.locals.values()) local.limits = this.http.limits;
      return;
    }
    if (value.type === "job.assign") {
      void this.assignOnce(value.payload)
        .then((observation) => {
          this.session?.send({
            type: "job.start_ack",
            requestId: value.requestId,
            payload: {
              identity: value.payload.identity,
              ack: { deliveryId: value.requestId, sequence: 0, persisted: true },
            },
          });
          this.session?.send({
            type: "job.query_result",
            requestId: randomUUID(),
            payload: observation,
          });
        })
        .catch(() => {
          this.session?.socket?.close(1008, "assignment rejected");
        });
      return;
    }
    if (value.type === "job.query") {
      this.session?.send({
        type: "job.query_result",
        requestId: value.requestId,
        payload: this.queryExisting(value.payload),
      });
      return;
    }
    if (value.type === "job.cancel") {
      this.session?.send({
        type: "job.cancel_ack",
        requestId: value.requestId,
        payload: {
          identity: value.payload.identity,
          disposition: await this.cancel(value.payload.identity, value.payload.reason),
        },
      });
      return;
    }
    if (value.type === "job.output_ack" || value.type === "job.result_ack") {
      this.ledger.ack(value.payload, value.type === "job.output_ack" ? "output" : "result");
      this.session?.deliveries.delete(value.payload.deliveryId);
      this.flush();
      return;
    }
    if (value.type === "job.lease_update") {
      this.leaseUpdate(value.payload);
      return;
    }
    if (value.type === "job.committed") {
      await this.committed(value.payload);
      return;
    }
    if (value.type === "local_policy.decision") {
      return;
    } // Remote decisions never mutate local approval state.
    if (value.type === "workspace.request") {
      void this.handleWorkspaceFrame(value)
        .then((response) => this.session?.send(response))
        .catch(() => this.session?.socket?.close(1008, "workspace request identity conflict"));
      return;
    }
    if (value.type === "transfer.open") {
      void this.transfer(value.payload).catch(() => {});
      return;
    }
    if (value.type === "executor.presence") {
      if (value.payload.state === "revoking") {
        this.revoked = true;
        this.http.revoked = true;
        for (const identity of this.ledger.identities())
          void this.cancel(identity, "revoked").catch(() => {});
      }
      return;
    }
    if (
      value.type === "executor.heartbeat" ||
      value.type === "transfer.status" ||
      value.type === "job.query_result"
    )
      return;
    throw new Error("unexpected inbound executor frame");
  }
  async handleWorkspaceFrame(
    value: Extract<ExecutorFrame, { type: "workspace.request" }>,
  ): Promise<Extract<ExecutorFrame, { type: "workspace.response" }>> {
    await this.currentPolicy();
    this.http.assertExecutorAuthority();
    if (Buffer.byteLength(canonicalJson(value)) > this.http.jsonBytes)
      throw new Error("payload_too_large: encoded frame");
    frame(value);
    const { requestId, correlationId, request } = value.payload,
      local = this.locals.get(request.rootBindingId);
    if (!local) throw new Error("local binding unavailable");
    const digest = hash(canonicalJson(value.payload)),
      requestKey = `workspace_request_${requestId}`,
      correlationKey = `workspace_correlation_${correlationId}`;
    this.ledger.transaction(() => {
      for (const key of [requestKey, correlationKey]) {
        const old = this.ledger.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
          | { value: string }
          | undefined;
        if (old && old.value !== digest)
          throw new Error("workspace request/correlation body conflict");
        if (!old) {
          this.ledger.capacity(Buffer.byteLength(canonicalJson(value.payload)) + 4096, true);
          this.ledger.db.prepare("INSERT INTO meta VALUES (?,?)").run(key, digest);
        }
      }
    });
    let work = this.workspaceRequests.get(requestId);
    if (!work) {
      if (this.workspaceRequests.size >= Math.min(32, this.http.limits.queuedAdmissions))
        throw new Error("workspace request concurrency exhausted");
      work = local
        .request(request)
        .catch((error: unknown): ErrorBody => {
          const message = error instanceof Error ? error.message : "unknown";
          if (/payload_too_large|capacity|chunk grid/.test(message))
            return {
              error: {
                code: "payload_too_large",
                message: "Local metadata or capacity limit exceeded",
                requestId,
                retryable: false,
              },
            };
          const reason = message.includes("revision_unavailable")
            ? "revision_unavailable"
            : message.includes("expired_lease")
              ? "expired_lease"
              : message.includes("stale_fence")
                ? "stale_fence"
                : message.includes("uncertain")
                  ? "uncertain_effects"
                  : "local_drift";
          return {
            error: {
              code: "workspace.conflict",
              message: "Local workspace requires current authority or recovery",
              requestId,
              retryable: false,
              details: { reason },
            },
          };
        })
        .then((response) => {
          this.ledger.db
            .prepare(
              "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            )
            .run(`workspace_response_${requestId}`, canonicalJson(response));
          return response;
        })
        .finally(() => {
          this.workspaceRequests.delete(requestId);
        });
      this.workspaceRequests.set(requestId, work);
    }
    return {
      type: "workspace.response",
      requestId: value.requestId,
      payload: { requestId, correlationId, response: await work },
    };
  }
  async transfer(descriptor: TransferDescriptor): Promise<void> {
    await this.currentPolicy();
    this.http.assertExecutorAuthority();
    const key = `${descriptor.transferId}:${descriptor.attemptId}`;
    if (this.transfers.has(key) || this.transfers.size >= this.http.limits.transferConcurrency)
      throw new Error("local transfer concurrency exhausted");
    this.transfers.add(key);
    try {
      await this.transferOnce(descriptor);
    } finally {
      this.transfers.delete(key);
    }
  }
  private async transferOnce(descriptor: TransferDescriptor): Promise<void> {
    this.staging.check(descriptor);
    if (descriptor.purpose === "local-stage") {
      await this.staging.receive(descriptor);
      return;
    }
    if (descriptor.purpose !== "output" || descriptor.content.kind !== "job-output")
      throw new Error("local reads require correlated workspace request");
    const row = this.ledger.get(descriptor.jobId);
    const reference = row?.result?.output.artifacts.find(
      (a) => a.artifactId === descriptor.content.artifactId,
    );
    if (
      !reference ||
      reference.sha256 !== descriptor.fileSha256 ||
      reference.size !== descriptor.size
    )
      throw new Error("output owner mismatch");
    const { readFile } = await import("node:fs/promises");
    const path = join(this.directory, "artifacts", descriptor.content.artifactId);
    await this.platform.verifyProtection(path, false);
    const data = await readFile(path);
    for (let i = 0; i < descriptor.chunkHashes.length; i++) {
      this.staging.check(descriptor);
      await this.http.chunk(
        descriptor,
        i,
        data.subarray(i * descriptor.chunkBytes, (i + 1) * descriptor.chunkBytes),
      );
    }
  }
  async tick(): Promise<void> {
    if (this.reloadProfile) {
      try {
        await this.currentPolicy();
      } catch {
        this.revoked = true;
        this.http.revoked = true;
      }
    }
    if (this.connected) {
      try {
        this.http.assertExecutorAuthority();
      } catch {
        this.revoked = true;
        this.http.revoked = true;
        this.connected = false;
        for (const identity of this.ledger.identities())
          if (this.children.has(identity.jobId))
            await this.cancel(identity, "executor credential expired");
        this.session?.socket?.close(1008, "executor authority expired");
      }
    }
    for (const identity of this.ledger.identities())
      if (
        this.leaseLost(this.ledger.get(identity.jobId)?.assignment) &&
        this.children.has(identity.jobId) &&
        this.ledger.get(identity.jobId)?.state !== "unknown"
      )
        await this.cancel(identity, "expired lease");
    for (const local of this.locals.values()) await local.expirePrepared();
    const cleanup = this.ledger.db
      .prepare("SELECT value FROM meta WHERE key LIKE 'cleanup_pending_%' ORDER BY key LIMIT 1")
      .get() as { value: string } | undefined;
    if (cleanup && Date.now() >= (this.stageRetryAt.get(`cleanup_${cleanup.value}`) ?? 0)) {
      this.stageRetryAt.set(`cleanup_${cleanup.value}`, Date.now() + 5000);
      const row = this.ledger.get(cleanup.value);
      if (row?.committed && row.result?.manifestHash && !this.children.has(cleanup.value))
        await this.snapshots.cleanup(row.assignment, row.result.manifestHash).catch(() => {});
    }
    if (this.connected)
      for (const row of this.ledger.pending()) if (row.decision === "allow") await this.start(row);
    if (
      this.connected &&
      !this.revoked &&
      !this.http.pressureHeld &&
      Date.now() >= this.http.pausedUntil
    )
      for (const identity of this.ledger.identities()) {
        const row = this.ledger.get(identity.jobId);
        if (
          row?.result?.state === "unknown" &&
          !row.committed &&
          this.binding(row.assignment, false).providerKind === "computer" &&
          Date.now() >= (this.stageRetryAt.get(identity.jobId) ?? 0)
        ) {
          this.stageRetryAt.set(identity.jobId, Date.now() + 5000);
          await this.resumeStaging(identity).catch(() => {});
        }
      }
    this.flush();
  }
  private leaseLost(assignment: Assignment | undefined): boolean {
    if (!assignment) return true;
    const id = assignment.identity,
      binding = this.binding(assignment, false),
      floor = this.ledger.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get(`fence_${binding.rootBindingId}_${binding.bindingVersion}`) as
        | { value: string }
        | undefined;
    return (
      Date.now() >= Math.min(id.deadline, id.lease.expiresAt) ||
      !!(floor && BigInt(id.lease.fence) < BigInt(floor.value))
    );
  }
  async resumeStaging(identity: ExecutionIdentity): Promise<void> {
    this.identityAllowed(identity);
    const row = this.ledger.existing(identity);
    if (!row?.result || row.committed || this.children.has(identity.jobId)) return;
    const outcome = this.ledger.record<{
        state: PreparedResult["state"];
        possibleExternalEffects: boolean;
      }>("stages", `execution_outcome_${identity.executionId}`),
      scratch = this.ledger.record<{ path: string }>("stages", `scratch_${identity.executionId}`),
      intent = this.ledger.record<{ requestId: string; commitId: string }>(
        "stages",
        `upload_intent_${identity.executionId}`,
      );
    if (!outcome || outcome.state === "unknown" || !scratch || !intent) return;
    const root = await SafeRoot.open(scratch.path, this.platform),
      staged = await this.snapshots.stage(row.assignment, root, intent.requestId, intent.commitId);
    const result: PreparedResult = {
      ...row.result,
      state: outcome.state,
      sequence: row.sequence + 1,
      uploadId: staged.uploadId,
      commitId: staged.commitId,
      manifestHash: staged.manifestHash,
    };
    this.ledger.transaction(() => {
      row.result = result;
      row.sequence = result.sequence;
      this.ledger.put(row);
      this.ledger.enqueue(identity.jobId, "result", result.sequence, {
        type: "job.prepared_result",
        requestId: randomUUID(),
        payload: result,
      });
    });
    this.flush();
  }
}

export async function runDaemon(
  profile: Profile,
  directory: string,
  signal: AbortSignal,
  reloadProfile?: () => Promise<Profile>,
  localTest = false,
): Promise<void> {
  const platform = adapter(),
    limits = effectiveLimits(profile.limits),
    roots = new Map<string, SafeRoot>();
  for (const binding of profile.bindings)
    roots.set(binding.rootBindingId, await SafeRoot.open(binding.path, platform));
  const guards: Guard[] = [];
  let ledger: Ledger | undefined;
  try {
    guards.push(
      ...(await rootRegistry(
        join(stateHome(), "roots"),
        [...roots.values()].map((root) => ({
          key: root.key,
          ledgerId: profile.ledgerId,
          ledgerPath: directory,
        })),
        platform,
        ledgerRegistryIdentity(profile, directory, "bind"),
      )),
    );
    guards.push(await Guard.acquire(join(directory, "daemon.guard.sqlite"), platform));
    ledger = await Ledger.open(directory, profile.ledgerId, limits, platform);
    ledger.recover();
    const runtime = new ExecutorRuntime({
      profile,
      ledger,
      directory,
      platform,
      roots,
      http: new HttpTransport(profile, fetch, localTest),
      ...(reloadProfile ? { reloadProfile } : {}),
    });
    await runtime.initialize();
    const session = new SessionTransport(runtime.http, runtime);
    runtime.session = session;
    let ticking = false;
    const tick = setInterval(() => {
      if (!ticking) {
        ticking = true;
        void runtime
          .tick()
          .catch(() => {})
          .finally(() => {
            ticking = false;
          });
      }
    }, 500);
    let retry = 500;
    try {
      while (!signal.aborted && !runtime.revoked) {
        const registration: Extract<ExecutorFrame, { type: "executor.register" }> = {
          type: "executor.register",
          requestId: randomUUID(),
          payload: {
            executorId: profile.executorId,
            generation: profile.executorGeneration,
            protocolVersion: "1.0",
            schemaVersion: "1.0.0",
            platform: platform.platform,
            caseBehavior: [...roots.values()].some((r) => r.identity.caseBehavior === "insensitive")
              ? "insensitive"
              : "sensitive",
            confinement: "host",
            capabilities: ["shell", "local-workspace", "snapshots"],
            transferLimits: runtime.http.transferLimits(),
            rootBindingIds: profile.bindings.map((b) => b.rootBindingId),
          },
        };
        try {
          await session.connect(signal, registration);
          retry = 500;
        } catch {
          /* Redacted transport diagnostics: never URLs/tokens/arguments. */
        }
        if (signal.aborted) break;
        const wait =
          Math.min(30000, Math.max(retry, runtime.http.pausedUntil - Date.now())) +
          Math.floor(Math.random() * 250);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, wait);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          }
          signal.addEventListener("abort", done, { once: true });
        });
        retry = Math.min(30000, retry * 2);
      }
    } finally {
      clearInterval(tick);
      for (const identity of ledger.identities())
        if (runtime.children.has(identity.jobId)) await runtime.cancel(identity, "daemon stopping");
    }
  } finally {
    ledger?.close();
    for (const guard of guards.reverse()) guard.close();
  }
}
