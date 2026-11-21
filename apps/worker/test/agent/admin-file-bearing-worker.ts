import type * as D from "../../src/boundary/dto.js";
import { WorkspaceObject as RealWorkspaceObject } from "../../src/workspace/workspace-object.js";

export {
  ControlPlane,
  default,
  LinuxContainerHost,
  StorageGuardProbe,
  TestAgentSession,
  WorkspaceProxy,
} from "./runtime-worker.js";

export interface ExportObservation {
  resources: D.ResourceScope;
  action: D.ExportRequest["action"];
  maxBytes: number;
  result: D.Outcome<D.ExportDescriptor>;
}

/** Observe the real public producer port; never substitute descriptors or bytes. */
export class WorkspaceObject extends RealWorkspaceObject {
  private observation: ExportObservation | undefined;
  override async exportData(ctx: D.AuthContext, input: D.ExportRequest) {
    const result = await super.exportData(ctx, input);
    this.observation = structuredClone({
      resources: input.resources,
      action: input.action,
      maxBytes: input.maxBytes,
      result,
    });
    return result;
  }
  exportObservationJson() {
    return JSON.stringify(this.observation ?? null);
  }
}
