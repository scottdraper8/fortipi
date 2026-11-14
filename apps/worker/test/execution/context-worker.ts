import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type * as D from "../../src/boundary/dto.js";
import type { ToolContext } from "../../src/execution/context.js";
import worker, { TestAgentSession as ExistingSession } from "../agent/runtime-worker.ts";

export { ControlPlane, StorageGuardProbe, WorkspaceObject } from "../agent/runtime-worker.ts";

/** Only model decisions are synthetic. Coordinates come exclusively from the actual tool result. */
export class TestAgentSession extends ExistingSession {
  #samples: {
    user?: string;
    tools?: string[];
    context?: ToolContext;
    dispatch?: D.JsonObject;
    argumentContractVisible?: boolean;
  }[] = [];
  #override: D.BackendRef | undefined;
  #gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  async holdContext() {
    this.#gate = Promise.withResolvers<void>();
  }
  async releaseContext() {
    this.#gate?.resolve();
    this.#gate = undefined;
  }
  async explicitTarget(target?: D.BackendRef) {
    this.#override = target;
  }
  async samples() {
    return JSON.stringify(this.#samples);
  }
  override async queueTool(argumentsJson: string) {
    if (argumentsJson !== "context") return super.queueTool(argumentsJson);
    await this.lifecycle.start();
    await this.pi.pi();
    const faux = this.faux;
    if (!faux) throw new Error("Synthetic model unavailable");
    faux.setResponses([
      async (context) => {
        const user = context.messages.filter((m) => m.role === "user").at(-1);
        this.#samples.push({
          user: user && typeof user.content === "string" ? user.content : "",
          tools: context.messages.flatMap((m) =>
            "toolsAdded" in m ? (m.toolsAdded ?? []).map((t) => t.name) : [],
          ),
          argumentContractVisible: context.messages.some(
            (m) =>
              "toolsAdded" in m &&
              (m.toolsAdded ?? []).some(
                (tool) =>
                  tool.name === "fortipi_dispatch" &&
                  JSON.stringify(tool.parameters).includes('"command"') &&
                  JSON.stringify(tool.parameters).includes('"source"'),
              ),
          ),
        });
        return fauxAssistantMessage(
          fauxToolCall("fortipi_context", { tool: "shell", capabilities: ["shell"] }),
          { stopReason: "toolUse" },
        );
      },
      async (context) => {
        const result = context.messages
          .filter((m) => m.role === "toolResult" && m.toolName === "fortipi_context")
          .at(-1);
        if (!result || result.role !== "toolResult" || result.isError)
          throw new Error("Actual discovery failed");
        const text = result.content.find((c) => c.type === "text");
        if (!text || text.type !== "text") throw new Error("Discovery text missing");
        const discovered = JSON.parse(text.text) as ToolContext;
        this.#samples.push({ context: discovered });
        await this.#gate?.promise;
        const workspace =
          discovered.workspaces.find((w) => w.configured) ?? discovered.workspaces[0];
        if (!workspace) throw new Error("No scoped workspace discovered");
        const native = discovered.targets.find(
          (candidate) => candidate.argumentFormat === "native-shell",
        );
        if (!native || !discovered.argumentContracts[native.argumentFormat]?.includes('"command"'))
          throw new Error("Native argument contract missing");
        const dispatch: D.JsonObject = {
          tool: "shell",
          arguments: { command: native.platform === "win32" ? "Get-ChildItem -Name" : "ls" },
          workspaceId: workspace.workspaceId,
          baseRevision: workspace.baseRevision,
          capabilities: ["shell"],
          ...(this.#override ? { target: this.#override } : {}),
        };
        this.#samples.push({ dispatch });
        return fauxAssistantMessage(fauxToolCall("fortipi_dispatch", dispatch), {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage("Listed configured workspace files."),
    ]);
  }
  async topologyPages(jobId: string) {
    const state = await this.jobs.state(jobId),
      auth = { ...state.auth, deadline: Date.now() + 30000 };
    const targets: D.BackendRef[] = [];
    let executorPageToken: string | undefined;
    do {
      const page = await this.authority.control.toolTopology(auth, {
        agentId: this.agentId,
        conversationId: state.job.conversationId,
        workspaceId: state.job.workspaceId,
        tool: state.operation.tool,
        capabilities: state.operation.capabilities,
        ...(executorPageToken ? { executorPageToken } : {}),
      });
      if (!page.ok) throw new Error(`Scoped topology refused: ${page.code}`);
      targets.push(...page.value.targets.map((candidate) => candidate.target));
      executorPageToken = page.value.nextExecutorPageToken;
    } while (executorPageToken);
    return JSON.stringify(targets);
  }
  async routeState() {
    return JSON.stringify({
      intents: (
        await this.store.page<{ target?: D.BackendRef; jobId: string }>("tool-intent", 100)
      ).map((r) => r.value),
      jobs: (await this.store.page<import("../../src/execution/jobs.js").JobState>("job", 100)).map(
        (r) => ({
          jobId: r.value.job.jobId,
          operation: r.value.operation,
          execution: r.value.assignment?.identity,
          state: r.value.job.state,
        }),
      ),
    });
  }
}
export default worker;
