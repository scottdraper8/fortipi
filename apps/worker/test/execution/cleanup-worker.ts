import type * as D from "../../src/boundary/dto.js";
import { WorkspaceObject as RealWorkspace } from "../../src/workspace/workspace-object.js";
import { ControlPlane as BaseControlPlane } from "../agent/runtime-worker.js";

export {
  default,
  LinuxContainerHost,
  StorageGuardProbe,
  TestAgentSession,
  WorkspaceProxy,
} from "../agent/runtime-worker.js";

export class ControlPlane extends BaseControlPlane {
  #cancellation:
    | {
        ok: boolean;
        code?: D.ErrorCode;
        dispatchGrant: boolean;
        cancelGrant: boolean;
        taskCancelGrant: boolean;
      }
    | undefined;
  override async cancelExecution(auth: D.AuthContext, input: D.CancelRequest) {
    const result = await super.cancelExecution(auth, input);
    this.#cancellation = {
      ok: result.ok,
      ...(!result.ok ? { code: result.code } : {}),
      dispatchGrant: auth.grants.some((grant) => grant.resources.actions.includes("jobs.dispatch")),
      cancelGrant: auth.grants.some((grant) => grant.resources.actions.includes("jobs.cancel")),
      taskCancelGrant: auth.grants.some((grant) =>
        grant.resources.actions.includes("tasks.cancel"),
      ),
    };
    return result;
  }
  cancellationFacts() {
    return this.#cancellation ?? null;
  }
}

/** Lose only the transport reply; the real Workspace owns the cleanup transaction. */
export class WorkspaceObject extends RealWorkspace {
  #lose = false;
  #committed = 0;
  loseAbortReply(value: boolean) {
    this.#lose = value;
  }
  abortFacts() {
    return { committed: this.#committed };
  }
  override async abortUpload(
    auth: D.AuthContext,
    input: D.OperationRequest<"abortUpload">,
  ): Promise<D.Outcome<D.OperationResponse<"abortUpload">>> {
    const result = await super.abortUpload(auth, input);
    if (result.ok) {
      this.#committed++;
      if (this.#lose)
        return {
          ok: false,
          code: "interrupted",
          message: "Synthetic transport reply lost after actual Workspace cleanup",
          requestId: auth.requestId,
          retryable: true,
          details: { reason: "uncertain_effects" },
        };
    }
    return result;
  }
}
