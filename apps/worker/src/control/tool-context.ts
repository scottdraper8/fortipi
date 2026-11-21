import { requireCapability, wireLimits } from "fortipi-contract";
import { ServiceError } from "../api/common.js";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { operationalMetadata } from "../execution/metadata.js";
import { argumentContracts, backendSupportsTool } from "../execution/tool-arguments.js";
import { contains, emptyScope, permits } from "./authorization.js";
import type { Directory } from "./directory.js";
import { valid } from "./directory.js";
import type { Executors } from "./executors.js";
import { ControlError, check, same } from "./store.js";
import type { ExecutorState, Tickets } from "./tickets.js";

/** A bounded read of current authority and advertised reachability; never an execution grant. */
export function toolTopology(
  directory: Directory,
  executors: Executors,
  env: Env,
  ctx: D.AuthContext,
  input: D.ToolContextRequest,
): D.ToolTopology {
  const registration = directory.registeredAuthority(ctx);
  check(
    ctx.role !== "executor" &&
      registration?.recipient.kind === "agent" &&
      registration.recipient.id === input.agentId &&
      registration.resources.agentIds.includes(input.agentId) &&
      registration.resources.conversationIds.includes(input.conversationId) &&
      valid("common", "Id", input.agentId) &&
      valid("common", "Id", input.conversationId) &&
      typeof input.tool === "string" &&
      input.tool.length > 0 &&
      input.tool.length <= 128 &&
      Array.isArray(input.capabilities) &&
      input.capabilities.length <= 100 &&
      input.capabilities.every((c) => typeof c === "string" && c.length > 0 && c.length <= 128) &&
      (input.workspaceId === undefined || valid("common", "Id", input.workspaceId)) &&
      [input.pageToken, input.executorPageToken].every(
        (token) => token === undefined || (typeof token === "string" && token.length <= 1024),
      ) &&
      (input.limit === undefined ||
        (Number.isSafeInteger(input.limit) && input.limit > 0 && input.limit <= 100)) &&
      (!input.workspaceId || !input.pageToken) &&
      (input.target === undefined ||
        (Number.isSafeInteger(input.target.generation) &&
          input.target.generation > 0 &&
          (input.target.kind === "executor"
            ? valid("common", "Id", input.target.executorId)
            : input.target.kind === "backend" && valid("common", "Id", input.target.backendId)))),
    "unauthorized",
    "Tool topology requires its registered initiating Agent operation",
  );
  const config = directory.config();
  const preference =
    "routing" in config ? config.routing : { kind: "explicit" as const, targetIds: [] };
  const result: D.ToolTopology = { routing: { ...preference, targetIds: [] }, workspaces: [] };
  const limit = Math.min(input.limit ?? 4, directory.policy().bounds.sqlPageRows, 100);
  const view = `tool-context:${input.agentId}:${input.conversationId}:${input.tool}:${config.version}:${ctx.grantVersion}`;
  const discoveryScope = {
    ...emptyScope(),
    agentIds: [input.agentId],
    conversationIds: [input.conversationId],
    tools: [input.tool],
    actions: ["jobs.dispatch", "workspace.write"],
    ...(input.workspaceId ? { workspaceIds: [input.workspaceId] } : {}),
  };
  const ids = (dimension: "workspaceIds" | "executorIds"): string[] | undefined => {
    const found = new Set<string>();
    for (const grant of ctx.grants) {
      if (!permits([grant], discoveryScope, "jobs.dispatch")) continue;
      if (grant.resources[dimension].includes("*")) return undefined;
      for (const id of grant.resources[dimension]) found.add(id);
    }
    return [...found];
  };
  const page = <T>(
    kind: "binding" | "executor",
    scoped: string[] | undefined,
    token: string | undefined,
  ) => {
    const cursorView = `${view}:${kind}:${scoped ? "scoped" : "global"}`;
    const after = directory.cursor(ctx, cursorView, token);
    const rows = scoped
      ? scoped.slice(after, after + limit).flatMap((key, index) => {
          const value = directory.store.get<T>(kind, key);
          return value ? [{ key, value, seq: after + index + 1 }] : [];
        })
      : directory.store.page<T>(kind, after, limit);
    const next = scoped
      ? after + limit < scoped.length
        ? after + limit
        : undefined
      : rows.length === limit
        ? rows.at(-1)?.seq
        : undefined;
    return {
      rows,
      ...(next !== undefined ? { next: directory.token(ctx, cursorView, next) } : {}),
    };
  };
  const bindingPage = input.workspaceId
    ? { rows: [] }
    : page<D.WorkspaceBinding>("binding", ids("workspaceIds"), input.pageToken);
  const bindingRows = bindingPage.rows;
  const bindings = input.workspaceId
    ? [directory.store.get<D.WorkspaceBinding>("binding", input.workspaceId)].filter(
        (b) => b !== undefined,
      )
    : bindingRows.map((r) => r.value);
  if (bindingPage.next) result.nextPageToken = bindingPage.next;
  const executorPage = input.target
    ? { rows: [] }
    : page<ExecutorState>("executor", ids("executorIds"), input.executorPageToken);
  const executorRows = executorPage.rows;
  const rows: { key: string; value: ExecutorState }[] =
    input.target?.kind === "executor"
      ? (() => {
          const value = directory.store.get<ExecutorState>("executor", input.target.executorId);
          return value ? [{ key: input.target.executorId, value }] : [];
        })()
      : executorRows;
  if (executorPage.next) result.nextExecutorPageToken = executorPage.next;
  const visible = new Set<string>();
  for (const binding of bindings) {
    const targets: D.ToolTopology["workspaces"][number]["targets"] = [];
    const resources = (target: D.BackendRef): D.ResourceScope => ({
      ...emptyScope(),
      agentIds: [input.agentId],
      conversationIds: [input.conversationId],
      workspaceIds: [binding.workspaceId],
      tools: [input.tool],
      actions: ["jobs.dispatch", "workspace.write"],
      ...(target.kind === "executor"
        ? { executorIds: [target.executorId] }
        : { backendIds: [target.backendId] }),
    });
    const capable = (capabilities: string[]) =>
      [input.tool, ...input.capabilities].every((c) => capabilities.includes(c));
    // Preserve global configured priority across target pages, exposing only IDs covered by a complete grant.
    for (const id of preference.targetIds)
      if (
        permits(
          ctx.grants,
          resources({ kind: "executor", executorId: id, generation: 1 }),
          "jobs.dispatch",
        ) ||
        permits(
          ctx.grants,
          resources({ kind: "backend", backendId: id, generation: 1 }),
          "jobs.dispatch",
        )
      )
        visible.add(id);
    for (const row of rows) {
      const description = row.value.description;
      const target: D.BackendRef = {
        kind: "executor",
        executorId: row.key,
        generation: row.value.generation,
      };
      if (
        input.tool !== "shell" ||
        !description ||
        description.generation !== target.generation ||
        description.state !== "online" ||
        (input.target && !same(input.target, target)) ||
        !capable(description.capabilities) ||
        !permits(ctx.grants, resources(target), "jobs.dispatch") ||
        (binding.config.kind === "local"
          ? binding.config.executorId !== row.key ||
            !description.rootBindingIds.includes(binding.config.rootBindingId) ||
            !description.capabilities.includes("local-workspace")
          : !description.capabilities.includes("snapshots"))
      )
        continue;
      try {
        const socket = executors.channel(row.key, target.generation);
        const attachment = executors.attachment(socket);
        if (!attachment) continue;
        const executorAuth = executors.context(attachment.identity);
        const transfer = {
          ...emptyScope(),
          agentIds: [input.agentId],
          conversationIds: [input.conversationId],
          workspaceIds: [binding.workspaceId],
          executorIds: [row.key],
          tools: [input.tool],
          actions: [
            "workspace.read",
            "workspace.write",
            "transfers.input",
            "transfers.output",
            "transfers.status",
          ],
        };
        if (
          !contains(attachment.identity.resources, transfer) ||
          !permits(executorAuth.grants, transfer, "workspace.read")
        )
          continue;
        executors.transferLimits(row.key, target.generation);
      } catch {
        continue;
      }
      targets.push({
        target,
        capabilities: [...new Set([input.tool, ...input.capabilities])],
        confinement: description.confinement,
        argumentFormat: "native-shell",
        platform: description.platform,
      });
      visible.add(row.key);
    }
    // Cloud execution uses the deployed backend. An active preference cannot invent a binding or entitlement.
    const deployed = env.FORTIPI_CONFIG;
    if (
      binding.config.kind === "computer" &&
      "execution" in deployed &&
      deployed.execution.kind !== "native"
    ) {
      const backend = deployed.execution;
      const capability = backend.kind === "cloud-js" ? "loader" : "containers";
      const capabilities =
        backend.kind === "cloud-js"
          ? ["javascript", "workspace.read", "workspace.write"]
          : ["shell", "workspace.read", "workspace.write"];
      const target: D.BackendRef = {
        kind: "backend",
        backendId: backend.backendId,
        generation: binding.bindingVersion,
      };
      if (
        backendSupportsTool(backend.kind, input.tool) &&
        capable(capabilities) &&
        requireCapability(directory.policy(), capability, ctx.deploymentId) &&
        requireCapability(deployed.infrastructure, capability, ctx.deploymentId) &&
        (capability === "loader" ? env.LOADER : env.LINUX_CONTAINERS) &&
        permits(ctx.grants, resources(target), "jobs.dispatch") &&
        (!input.target || same(input.target, target))
      ) {
        targets.push({
          target,
          capabilities,
          confinement: "isolated",
          argumentFormat: backend.kind === "cloud-js" ? "javascript-module" : "cloud-shell",
        });
        visible.add(backend.backendId);
      }
    }
    if (targets.length)
      result.workspaces.push({
        workspaceId: binding.workspaceId,
        bindingVersion: binding.bindingVersion,
        configured: "workspace" in config && same(config.workspace, binding.config),
        targets,
      });
  }
  result.routing.targetIds = preference.targetIds.filter((id) => visible.has(id));
  return result;
}
/** One scoped CP read composes the authoritative revision, without an extra registration RPC per workspace. */
export async function currentToolContext(
  directory: Directory,
  executors: Executors,
  tickets: Tickets,
  env: Env,
  ctx: D.AuthContext,
  input: D.ToolContextRequest,
): Promise<D.CurrentToolContext> {
  const topology = toolTopology(directory, executors, env, ctx, input);
  const result: D.CurrentToolContext = {
    routing: topology.routing,
    targets: [],
    argumentContracts,
    workspaces: [],
    ...(topology.nextPageToken ? { nextPageToken: topology.nextPageToken } : {}),
    ...(topology.nextExecutorPageToken
      ? { nextExecutorPageToken: topology.nextExecutorPageToken }
      : {}),
  };
  const read = async (
    workspace: D.ToolTopology["workspaces"][number],
  ): Promise<D.CurrentToolContext["workspaces"][number] | undefined> => {
    const target = workspace.targets[0]?.target;
    if (!target) return;
    const resources = {
      ...emptyScope(),
      agentIds: [input.agentId],
      conversationIds: [input.conversationId],
      workspaceIds: [workspace.workspaceId],
      tools: [input.tool],
      actions: ["jobs.dispatch", "workspace.write"],
      ...(target.kind === "executor"
        ? { executorIds: [target.executorId] }
        : { backendIds: [target.backendId] }),
    };
    const registered = tickets.register(ctx, {
      credential: {
        credentialId: ctx.credentialId,
        generation: ctx.generation,
        grantVersion: ctx.grantVersion,
      },
      recipient: { kind: "workspace", id: workspace.workspaceId },
      resources,
    });
    let binding: D.WorkspaceBinding;
    try {
      binding = await operationalMetadata(
        env.WORKSPACES.getByName(workspace.workspaceId),
        { ...ctx, registrationId: registered.registrationId },
        {
          agentId: input.agentId,
          conversationId: input.conversationId,
          workspaceId: workspace.workspaceId,
        },
      );
    } catch (error) {
      directory.identities.current(ctx);
      if (error instanceof ServiceError) {
        if (error.code === "unavailable" || error.code === "unavailable_executor") return;
        throw new ControlError(error.code, error.message, error.details);
      }
      throw error;
    }
    directory.identities.current(ctx);
    check(
      binding.bindingVersion === workspace.bindingVersion,
      "workspace.conflict",
      "Workspace binding changed during discovery",
    );
    if (binding.availability === "available")
      return {
        ...workspace,
        targets: workspace.targets.map((candidate) => candidate.target),
        baseRevision: binding.revision,
        provider: binding.config.kind,
      };
  };
  const seen = new Set<string>();
  const concurrency = Math.max(1, Math.min(4, directory.policy().bounds.transferConcurrency));
  const bytes = Math.min(wireLimits.inlineTailBytes, directory.policy().bounds.inlineTailBytes);
  for (let index = 0; index < topology.workspaces.length; index += concurrency) {
    const batch = topology.workspaces.slice(index, index + concurrency);
    const metadata = await Promise.all(batch.map(read));
    for (const [offset, workspace] of metadata.entries()) {
      if (!workspace) continue;
      result.workspaces.push(workspace);
      const source = batch[offset];
      check(source, "internal", "Metadata batch lost its topology");
      for (const candidate of source.targets) {
        const key = JSON.stringify(candidate.target);
        if (seen.has(key)) continue;
        seen.add(key);
        result.targets.push(candidate);
      }
    }
    check(
      new TextEncoder().encode(JSON.stringify(result)).length <= bytes,
      "payload_too_large",
      "Tool context page exceeds the output bound; lower limit or narrow workspace and capabilities",
    );
  }
  check(
    new TextEncoder().encode(JSON.stringify(result)).length <= bytes,
    "payload_too_large",
    "Tool context page exceeds the output bound; lower limit or narrow workspace and capabilities",
  );
  return result;
}
