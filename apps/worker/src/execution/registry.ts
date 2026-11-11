import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  createRegistry,
  defineDoc,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  runEndTask,
  type TaskId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import Ajv from "ajv/dist/2020.js";
import { operationDigest } from "fortipi-contract";
import type { Admission, Conversations } from "../agent/conversations.js";
import type { Projection } from "../agent/projection.js";
import { check, digest, resourceId, ServiceError, scope, unwrap } from "../api/common.js";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import type { Dispatch } from "./dispatch.js";
import { isTerminal, type Jobs } from "./jobs.js";
import { operationalMetadata } from "./metadata.js";

export const ChildDoc = defineDoc({
  kind: "fortipi.dispatch-child",
  version: 1,
  scope: "task",
  initial: (): { child: number | null } => ({ child: null }),
  checkpointWhen: () => true,
});
const parameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    tool: { type: "string", minLength: 1, maxLength: 128 },
    arguments: { type: "object", additionalProperties: true },
    workspaceId: { type: "string", minLength: 1, maxLength: 128 },
    baseRevision: { type: "string", minLength: 1, maxLength: 128 },
    target: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "executor" },
            executorId: { type: "string" },
            generation: { type: "integer", minimum: 1 },
          },
          required: ["kind", "executorId", "generation"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "backend" },
            backendId: { type: "string" },
            generation: { type: "integer", minimum: 1 },
          },
          required: ["kind", "backendId", "generation"],
        },
      ],
    },
    capabilities: { type: "array", items: { type: "string" }, maxItems: 100 },
  },
  required: ["tool", "arguments", "workspaceId", "baseRevision", "target", "capabilities"],
} as const;
interface ToolInput {
  tool: string;
  arguments: D.JsonObject;
  workspaceId: string;
  baseRevision: string;
  target: D.BackendRef;
  capabilities: string[];
}
const validTool = new Ajv({ strict: true }).compile<ToolInput>(parameters);
interface DispatchResult {
  output: string;
  isError: boolean;
}
export type DispatchTask = ReturnType<
  typeof defineTask<{ jobId: string }, { phase: "step" }, DispatchResult>
>;
interface Intent {
  jobId: string;
  operationId: string;
  argumentDigest: string;
  deadline: number;
  auth: D.AuthContext;
  conversationId: string;
  taskId: string;
}
export function buildRegistry(deps: {
  jobs: Jobs;
  dispatch: Dispatch;
  projection: Projection;
  conversations: Conversations;
  env: Env;
  dispatchReady?: (task: DispatchTask) => void;
}) {
  const { jobs, dispatch, projection, conversations } = deps;
  const dispatchTask = defineTask<{ jobId: string }, { phase: "step" }, DispatchResult>({
    name: "fortipi.dispatch",
    version: 1,
    initial: () => ({ phase: "step" }),
    phases: {
      step: async (task, runtime, context) => {
        let progress: { done: boolean; wakeAt?: number };
        try {
          progress = await dispatch.tick(task.input.jobId);
        } catch (error) {
          // Reentry queries the persisted attempt. Error text is never persisted or model-visible.
          const state = await jobs.state(task.input.jobId);
          await jobs.store.put("job-pressure", state.job.jobId, {
            phase: state.job.state,
            code: error instanceof ServiceError ? error.code : "interrupted",
            message:
              error instanceof ServiceError ? error.message : "Dispatch transport interrupted",
          });
          if (state.deadline <= Date.now()) {
            await jobs.interrupt(task.input.jobId, "Dispatch deadline reached during recovery");
            progress = { done: true };
          } else {
            await runtime.sleepUntil(
              Math.min(state.deadline, Date.now() + 30000),
              { phase: "step" },
              context,
            );
            return;
          }
        }
        if (progress.done) {
          const state = await jobs.state(task.input.jobId);
          const pendingTerminal = await jobs.store.get("terminal-notification", state.job.jobId);
          const result: DispatchResult = {
            output: pendingTerminal
              ? "Execution completed; executor terminal confirmation remains pending"
              : (state.job.preparedResult?.output.tail ?? `Job ${state.job.state}`),
            isError: state.job.state !== "completed" || !!pendingTerminal,
          };
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result } }),
            context,
          );
          return;
        }
        await runtime.sleepUntil(progress.wakeAt ?? Date.now() + 5000, { phase: "step" }, context);
      },
    },
    abort: async (task, runtime, context) => {
      const state = await jobs.state(task.input.jobId);
      if (!isTerminal(state.job)) {
        state.cancel ??= { requestId: `abort_${state.job.jobId}`, reason: "Pi tool cancelled" };
        await dispatch.save(state);
        await dispatch.tick(task.input.jobId).catch(() => {});
      }
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", reason: "cancelled" } }),
        context,
      );
    },
  });
  const projectTask = defineTask<{ conversationId: number }, { phase: "project" }, null>({
    name: "fortipi.project",
    version: 1,
    initial: () => ({ phase: "project" }),
    phases: {
      project: async (task, runtime, context) => {
        const mapped = await jobs.store.get<{ conversationId: string }>(
          "pi-map",
          String(task.input.conversationId),
        );
        if (mapped) {
          const more = await projection.entries(mapped.conversationId);
          if (more) {
            await runtime.sleepUntil(Date.now() + 1, { phase: "project" }, context);
            return;
          }
        }
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  deps.dispatchReady?.(dispatchTask);
  const tool = defineTool({
    name: "fortipi_dispatch",
    description:
      "Request an exact authorized workspace tool operation. Host execution requires independent executor consent. Mutations wait for approval; uncertain dispatch is queried, never rerun.",
    parameters,
    replay: "unsafe",
    execute: async (input, api, context) => {
      check(validTool(input), "invalid_request", "Invalid tool input");
      const args = input;
      const key = `${jobs.authority.agentId}:${api.conversationId}:${api.taskId}`;
      const argumentDigest = await digest(args);
      let intent = await jobs.store.get<Intent>("tool-intent", key);
      if (intent)
        check(intent.argumentDigest === argumentDigest, "conflict", "Tool task arguments changed");
      else {
        const owner = await initiatingAdmission(api, context, conversations);
        intent = {
          jobId: resourceId("j", jobs.authority.agentId),
          operationId: resourceId("m", jobs.authority.agentId),
          argumentDigest,
          deadline: Date.now() + 300000,
          auth: owner.auth,
          conversationId: owner.conversationId,
          taskId: owner.taskId,
        };
        const candidate = intent;
        intent = await jobs.store.transaction(async (tx) => {
          const old = await jobs.store.get<Intent>("tool-intent", key, tx);
          if (old) {
            check(old.argumentDigest === argumentDigest, "conflict", "Tool task arguments changed");
            return old;
          }
          await jobs.store.put("tool-intent", key, candidate, tx);
          return candidate;
        });
      }
      const target = args.target as D.BackendRef;
      const arguments_ = args.arguments as D.JsonObject;
      const auth = { ...intent.auth, deadline: Date.now() + 30000 };
      const resources = scope({
        agentIds: [jobs.authority.agentId],
        conversationIds: [intent.conversationId],
        actions: ["jobs.dispatch"],
        workspaceIds: [args.workspaceId],
        tools: [args.tool],
        ...(target.kind === "executor"
          ? { executorIds: [target.executorId] }
          : { backendIds: [target.backendId] }),
      });
      const jobRegistration = unwrap(
        await jobs.authority.control.registerAuthorityRecipient(auth, {
          credential: {
            credentialId: auth.credentialId,
            generation: auth.generation,
            grantVersion: auth.grantVersion,
          },
          recipient: { kind: "agent", id: jobs.authority.agentId },
          resources,
        }),
      );
      auth.registrationId = jobRegistration.registrationId;
      await jobs.authority.current(auth, resources);
      const preimage: D.OperationDigestInput = {
        deploymentId: auth.deploymentId,
        agentId: jobs.authority.agentId,
        conversationId: intent.conversationId,
        tool: args.tool,
        arguments: arguments_,
        workspaceId: args.workspaceId,
        baseRevision: args.baseRevision,
        target,
        policyVersion: 1,
        grantVersion: auth.grantVersion,
        deadline: intent.deadline,
      };
      const opDigest = await operationDigest(preimage);
      const operation: D.ApprovalOperation = {
        operationId: intent.operationId,
        operationDigest: opDigest,
        tool: args.tool,
        arguments: arguments_,
        workspaceId: args.workspaceId,
        baseRevision: args.baseRevision,
        target,
        trust: target.kind === "executor" ? "host" : "isolated",
        capabilities: args.capabilities,
        policyVersion: 1,
        grantVersion: auth.grantVersion,
        expiresAt: intent.deadline,
      };
      const existing = await jobs.store.get<{ jobId: string; digest: string }>("job-task", key);
      if (!existing) {
        await jobs.authority.physical.beforeGrowth(auth, resources);
        const capacity = unwrap(
          await jobs.authority.control.reserveCapacity(auth, {
            operationId: intent.operationId,
            ownerId: intent.conversationId,
            policyVersion: 1,
            bytes: 16384,
            admissionSlots: 0,
          }),
        );
        const ws = deps.env.WORKSPACES.getByName(args.workspaceId);
        const registered = unwrap(
          await jobs.authority.control.registerAuthorityRecipient(auth, {
            credential: {
              credentialId: auth.credentialId,
              generation: auth.generation,
              grantVersion: auth.grantVersion,
            },
            recipient: { kind: "workspace", id: args.workspaceId },
            resources: {
              agentIds: [jobs.authority.agentId],
              conversationIds: [intent.conversationId],
              workspaceIds: [args.workspaceId],
              actions: ["jobs.dispatch", "workspace.write"],
              tools: [args.tool],
              executorIds: target.kind === "executor" ? [target.executorId] : [],
              backendIds: target.kind === "backend" ? [target.backendId] : [],
            },
          }),
        );
        const binding = await operationalMetadata(
          ws,
          { ...auth, registrationId: registered.registrationId },
          {
            agentId: jobs.authority.agentId,
            conversationId: intent.conversationId,
            workspaceId: args.workspaceId,
            baseRevision: args.baseRevision,
          },
        );
        if (binding.config.kind === "local") {
          check(
            target.kind === "executor" && target.executorId === binding.config.executorId,
            "conflict",
            "Local workspace target changed",
          );
        }
        let executorTransferLimits: D.ExecutorTransferLimits | undefined;
        if (target.kind === "executor") {
          const current = unwrap(
            await jobs.authority.control.resolveExecutorGeneration(auth, {
              workspaceId: args.workspaceId,
              bindingVersion: binding.bindingVersion,
              executorId: target.executorId,
            }),
          );
          check(
            current.executorGeneration === target.generation,
            "conflict",
            "Local executor generation changed",
          );
          if (current.transferLimits) executorTransferLimits = current.transferLimits;
        }
        const job: D.Job = {
          jobId: intent.jobId,
          agentId: jobs.authority.agentId,
          conversationId: intent.conversationId,
          taskId: intent.taskId,
          workspaceId: args.workspaceId,
          baseRevision: args.baseRevision,
          operationDigest: opDigest,
          state: "created",
          version: 1,
        };
        const draft: D.EventDraft = {
          protocolVersion: "1.0",
          schemaVersion: "1.0.0",
          deploymentId: auth.deploymentId,
          conversationId: intent.conversationId,
          durability: "durable",
          type: "job.state.changed",
          payload: job,
          jobId: job.jobId,
          taskId: job.taskId,
        };
        await jobs.seed(
          auth,
          { job, piTaskId: key, capacityReservationId: capacity.reservationId, event: draft },
          operation,
          binding.bindingVersion,
          intent.deadline,
        );
        {
          const state = await jobs.state(job.jobId);
          if (executorTransferLimits) state.executorTransferLimits = executorTransferLimits;
          state.baseManifestHash = binding.manifestHash;
          if (binding.config.kind === "local") state.rootBindingId = binding.config.rootBindingId;
          await dispatch.save(state);
        }
      }
      // Child allocation and reference share ONE Pi commit. No app SQL or remote call runs inside it.
      const childId = await api.commit(async (tx) => {
        const doc = await tx.doc(ChildDoc, api.taskId);
        if (doc.child !== null) return doc.child as TaskId<DispatchResult>;
        const child = await tx.createTask(
          dispatchTask,
          { jobId: intent!.jobId },
          { ownership: { kind: "task", taskId: api.taskId }, abandonOnRestart: false },
        );
        doc.child = child;
        return child;
      }, context);
      context.abortSignal?.throwIfAborted();
      const child = await api.waitForTask(childId, context);
      const settled = child.state.outcome;
      if (settled.status !== "completed")
        return {
          output: [
            { type: "text" as const, text: "Dispatch interrupted; inspect the existing job" },
          ],
          isError: true,
        };
      return {
        output: [{ type: "text" as const, text: settled.result.output }],
        isError: settled.result.isError,
      };
    },
  });
  const registry = createRegistry();
  registry.install({
    name: "fortipi",
    tools: [tool],
    tasks: [dispatchTask, projectTask],
    hooks: [
      hook(GenerationTask, {
        afterRun: (_run, api) => ({
          tasks: [runEndTask(projectTask, { conversationId: api.conversationId })],
        }),
      }),
    ],
  });
  return registry;
}
async function initiatingAdmission(
  api: ToolExecutionApi,
  context: Context,
  conversations: Conversations,
): Promise<Admission> {
  const live = await api.snapshot(LiveDoc, api.conversationId, context);
  check(live?.run?.inputs.length, "unauthorized", "Tool invocation has no initiating admission");
  const harness = await conversations.host.pi.pi();
  const inputs = await harness.commit(
    async (tx) => Promise.all(live.run!.inputs.map((input) => tx.submission(input))),
    context,
  );
  const admissions: Admission[] = [];
  for (const input of inputs) {
    check(input?.requestId, "unauthorized", "Private input cannot claim application authority");
    const mapped = await conversations.host.store.get<{ key: string }>(
      "operation-admission",
      input.requestId,
    );
    check(mapped, "unauthorized", "Initiating application admission unavailable");
    const admission = await conversations.host.store.get<Admission>("admission", mapped.key);
    check(admission, "unauthorized", "Initiating application admission unavailable");
    admissions.push(
      admission.continuation?.operationId === input.requestId
        ? { ...admission, auth: admission.continuation.auth }
        : admission,
    );
  }
  const first = admissions[0];
  check(
    first &&
      admissions.every(
        (a) =>
          a.auth.principalId === first.auth.principalId &&
          a.auth.credentialId === first.auth.credentialId &&
          a.auth.generation === first.auth.generation &&
          a.auth.grantVersion === first.auth.grantVersion,
      ),
    "unauthorized",
    "Mixed initiating identities require a separately authorized operation",
  );
  return first;
}
