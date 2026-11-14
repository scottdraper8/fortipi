import { check } from "../api/common.js";
import { boundedJson, validate } from "../api/validation.js";
import type * as D from "../boundary/dto.js";

export async function operationalMetadata(
  workspace: { fetch(request: Request): Promise<Response> },
  auth: D.AuthContext,
  known: { agentId: string; conversationId: string; workspaceId: string; baseRevision?: string },
): Promise<D.WorkspaceBinding> {
  const url = new URL("https://workspace.internal/__fortipi/operational-metadata");
  if (known.baseRevision !== undefined) url.searchParams.set("revision", known.baseRevision);
  url.searchParams.set("agentId", known.agentId);
  url.searchParams.set("conversationId", known.conversationId);
  const signal = AbortSignal.timeout(Math.max(1, Math.min(30000, auth.deadline - Date.now())));
  const response = await workspace.fetch(
    new Request(url, {
      headers: { "x-fortipi-workspace-context": JSON.stringify({ auth }) },
      signal,
    }),
  );
  check(
    response.ok,
    response.status === 403
      ? "unauthorized"
      : response.status === 409
        ? "workspace.conflict"
        : "unavailable",
    "Operational workspace metadata unavailable",
  );
  const binding: unknown = await boundedJson({ body: response.body, signal }, 65536);
  validate<D.WorkspaceBinding>("WorkspaceBinding", binding);
  check(
    binding.workspaceId === known.workspaceId &&
      (known.baseRevision === undefined || binding.revision === known.baseRevision),
    "workspace.conflict",
    "Workspace base changed",
  );
  return binding;
}
