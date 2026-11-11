import type { Controller } from "./controller.js";
/** Remote text never supplies terminal controls, OSC links, bidi overrides or C1 controls. */
export function sanitize(value: string): string {
  const output: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const escaped = code === 27;
    const next = escaped ? value.charCodeAt(i + 1) : code;
    if (escaped || (code >= 128 && code <= 159)) {
      if (escaped) i++;
      if (next === 91 || code === 155) {
        while (++i < value.length) {
          const part = value.charCodeAt(i);
          if (part >= 64 && part <= 126) break;
        }
      } else if ([93, 80, 88, 94, 95].includes(next) || [144, 152, 157, 158, 159].includes(code)) {
        while (++i < value.length) {
          const part = value.charCodeAt(i);
          if (part === 7 || part === 156) break;
          if (part === 27 && value.charCodeAt(i + 1) === 92) {
            i++;
            break;
          }
        }
      }
      continue;
    }
    if (
      (code < 32 && code !== 9 && code !== 10) ||
      code === 127 ||
      (code >= 8234 && code <= 8238) ||
      (code >= 8294 && code <= 8297)
    )
      continue;
    output.push(value[i] as string);
  }
  return output.join("");
}
export function header(controller: Controller, profile: string, focus: string): string {
  const identity = controller.ticketIdentity;
  const who = identity
    ? `${identity.principalId} (${identity.role}) | credential ${identity.credential.credentialId} generation ${identity.credential.generation} grants ${identity.credential.grantVersion} | deployment ${identity.deploymentId}`
    : "Identity pending authenticated ticket";
  const state = controller.projection.snapshot?.conversation.taskState;
  const task =
    state?.state === "waiting" ? `waiting: ${state.reason}` : (state?.state ?? "no conversation");
  return sanitize(
    `FortiPi | ${profile} | ${controller.client.http.origin}\n${who}\n${controller.connection}${controller.projection.snapshot && controller.connection !== "online" ? " (stale)" : ""} | ${task} | ${controller.view} | focus ${focus}\n${controller.notice}${controller.pressure ? `\nCloudflare ${controller.pressure.resource}: ${controller.pressure.action}; ${controller.pressure.measurement} ${controller.pressure.scope.kind}; ${controller.pressure.reason}${controller.pressure.retryAt ? ` retry at ${controller.pressure.retryAt}` : ""}` : ""}`,
  );
}
export function content(controller: Controller): string {
  if (controller.view === "ids") return sanitize(controller.ids());
  if (controller.view === "help") return help;
  if (controller.view === "agents" || controller.view === "conversations")
    return sanitize(controller.searchProgress);
  if (controller.view !== "conversation") return sanitize(controller.detail);
  const projection = controller.projection;
  const lines =
    projection.snapshot?.messages.map(
      (message) => `${message.role} [${message.messageId}]\n${message.content}`,
    ) ?? [];
  for (const [id, text] of projection.output) lines.push(`stream [${id}] (uncommitted)\n${text}`);
  for (const job of projection.jobs.values())
    lines.push(
      `job ${job.jobId}: ${job.state}\n${job.execution ? JSON.stringify(job.execution.target) : ""}${job.preparedResult?.possibleExternalEffects ? "\nPossible external effects" : ""}`,
    );
  for (const [id, tool] of projection.tools)
    lines.push(
      `tool ${id}: ${tool.tool} (${tool.trust}) ${JSON.stringify(tool.target)} — /tool ${id}`,
    );
  for (const [id, state] of projection.workspaceState) lines.push(`workspace ${id}: ${state}`);
  for (const [id, ref] of projection.artifacts)
    lines.push(`artifact ${id}: ${ref.size} bytes @ ${ref.revision} (${ref.owner.kind})`);
  lines.push(...projection.generic);
  return sanitize(
    lines.join("\n\n") || "Use /agents to select an agent, then /new or reopen a conversation.",
  );
}
export const help = `Tab / Shift-Tab: cycle composer, list and transcript. Arrows / Enter: select. Escape: dismiss / stop search. PageUp / PageDown: output. Ctrl-C or /quit: exit.
/agents [search]  /conversations [search]  /more  /new [title]  /open ID [AGENT]
/steer text  /retry  /discard-intent  /task [ID]  /cancel [ID]  /resume ID continuation
/approvals [ID]  /approve  /reject
/reconcile [jobID]  /ack-unknown reason  /ack-failed reason  /discard-staging reason
/accept-result reason  /new-job newJobID authorizationID reason
/workspace ID  /diff workspaceID fromRevision toRevision  /read workspaceID revision path
/artifact ID [destination]  /ids  /copy  /profiles  /disconnect  /reconnect  /resnapshot  /help
Reopen requires a selected agent. Select it with /agents or supply /open ID AGENT.
Approval never enables native host trust. Configure an executor explicitly through the operator/executor tools.
Reconciliation observes uncertain effects; it never silently reruns a job. Cancel intent is not rollback.`;
