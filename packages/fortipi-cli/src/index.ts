import { join, resolve } from "node:path";
import type { OperationRequest, ProviderAuthDelete } from "fortipi-contract";
import { AdminClient } from "./admin.js";
import { argv, help, integer, required } from "./argv.js";
import { prepare, verifyPrepared } from "./assets.js";
import { readConfig, readJson } from "./config.js";
import { issueCredential } from "./credentials.js";
import { deploy } from "./deployment.js";
import { CliError, check } from "./errors.js";
import { initialize } from "./initialization.js";
import { terminalInteraction } from "./interaction.js";
import type { CliInteraction } from "./interaction-types.js";
import { installationId, loginAndIngest } from "./model-auth.js";
import { localModels, selectModel } from "./models.js";
import { loadProfile, profilePath, profileRoot, protectDirectory } from "./profiles.js";
import type { CommandOperation, CommandResult, ModelListing } from "./results.js";
import { ensureModelAuthKey, guidedSetup } from "./setup.js";
import { launchTui } from "./tui.js";
import { type WranglerPort, wrangler } from "./wrangler.js";

export { AdminClient } from "./admin.js";
export type { PrepareReceipt } from "./assets.js";
export type { OperatorConfig } from "./config.js";
export { operatorConfig, readConfig } from "./config.js";
export type { SafePressure } from "./errors.js";
export { CliError } from "./errors.js";
export type {
  CatalogModel,
  CommandResult,
  CredentialDelivery,
  DeploymentReceipt,
  ModelListing,
} from "./results.js";
export type { SetupResult } from "./setup.js";
export interface CommandContext {
  signal: AbortSignal;
  profileDirectory?: string;
  allowLoopback?: boolean;
  /** In-process adapters for controlled integration; never exposed as CLI options. */
  transport?: typeof fetch;
  wrangler?: WranglerPort;
  interaction?: CliInteraction;
}
export async function runCommand(input: string[], context: CommandContext): Promise<CommandResult> {
  const args = argv(input);
  if (args.options.help) return { help: help(args.command) };
  const get = (key: string) => required(args, key);
  const timeoutMs = args.options["timeout-ms"] ? integer(args, "timeout-ms", 1, 600000) : 30000;
  const root = context.profileDirectory ?? profileRoot();
  const selected = typeof args.options.profile === "string" ? args.options.profile : "default";
  const port = context.wrangler ?? wrangler;
  const interaction = () => {
    check(!args.options["non-interactive"], "interactive_terminal_required", 3);
    return context.interaction ?? terminalInteraction(context.signal);
  };
  const client = async (expectedOrigin?: string) => {
    const profile = await loadProfile(profilePath(selected, root), context.allowLoopback);
    if (expectedOrigin)
      check(
        profile.endpoint === expectedOrigin && profile.role === "admin",
        "exact_origin_admin_required",
        3,
      );
    return new AdminClient(profile, {
      signal: context.signal,
      timeoutMs,
      ...(context.allowLoopback ? { allowLoopback: true } : {}),
      ...(context.transport ? { transport: context.transport } : {}),
    });
  };
  const readInput = async () => readJson(get("input"));
  const page = () => ({
    ...(args.options.limit ? { limit: integer(args, "limit", 1, 100) } : {}),
    ...(args.options["page-token"] ? { pageToken: get("page-token") } : {}),
  });
  switch (args.command) {
    case "init": {
      await initialize(resolve(get("config")), {
        ...(typeof args.options.from === "string" ? { from: args.options.from } : {}),
        interaction,
      });
      return { state: "initialized" };
    }
    case "config validate": {
      const config = await readConfig(get("config"));
      if (args.options.remote) {
        const profile = await loadProfile(profilePath(selected, root), context.allowLoopback);
        check(profile.endpoint === config.deployment.origin, "profile_origin_mismatch", 3);
        const remote = await (await client()).call("getProtocol", {
          path: {},
          query: {},
          body: undefined,
        });
        return {
          valid: true,
          infrastructure: remote.infrastructure,
          backends: remote.backends,
          models: remote.models,
        };
      }
      return { valid: true };
    }
    case "login":
      interaction();
      await port.run({
        args: ["login"],
        cwd: resolve("."),
        terminal: true,
        deploymentAuth: true,
        signal: context.signal,
        timeoutMs,
      });
      return { state: "cloudflare_login_completed" };
    case "prepare":
      return prepare(
        get("config"),
        get("directory"),
        typeof args.options["previous-directory"] === "string"
          ? args.options["previous-directory"]
          : undefined,
      );
    case "deploy": {
      check(
        !args.options.bootstrap || ["local", "existing"].includes(get("bootstrap")),
        "invalid_bootstrap_mode",
      );
      return deploy(
        get("directory"),
        {
          dryRun: !!args.options["dry-run"],
          bootstrap: (args.options.bootstrap ?? "local") as "local" | "existing",
          nonInteractive: !!args.options["non-interactive"],
          profileName: selected,
          profileDirectory: root,
          ...(context.transport ? { transport: context.transport } : {}),
          signal: context.signal,
          timeoutMs,
        },
        port,
      );
    }
    case "setup":
      return guidedSetup({
        config: get("config"),
        directory: get("directory"),
        ...(typeof args.options.from === "string" ? { from: args.options.from } : {}),
        root,
        profile: selected,
        nonInteractive: !!args.options["non-interactive"],
        signal: context.signal,
        interaction,
        client,
        port,
        execute: (command) =>
          runCommand(
            [
              ...command,
              "--profile",
              selected,
              ...(args.options["non-interactive"] ? ["--non-interactive"] : []),
              "--timeout-ms",
              String(timeoutMs),
            ],
            context,
          ),
      });
    case "models list": {
      const provider =
        typeof args.options.provider === "string" ? args.options.provider : undefined;
      const local = {
        items: localModels(provider),
        workersAi: { providerId: "cloudflare", catalog: "deployed-protocol", auth: "AI-binding" },
      };
      let api: AdminClient;
      try {
        api = await client();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { ...local, deployed: { state: "not-configured" } } satisfies ModelListing;
      }
      try {
        const protocol = await api.call("getProtocol", { path: {}, query: {}, body: undefined });
        return {
          ...local,
          deployed: {
            state: "observed",
            items: protocol.models
              .filter((m) => !provider || m.providerId === provider)
              .map((m) => ({
                providerId: m.providerId,
                modelId: m.modelId,
                capabilities: [...m.capabilities],
                available: m.available,
              })),
          },
        } satisfies ModelListing;
      } catch {
        if (context.signal.aborted) throw new CliError("cancelled", 130);
        return { ...local, deployed: { state: "unavailable" } } satisfies ModelListing;
      }
    }
    case "models select":
      await selectModel(
        resolve(get("config")),
        get("provider"),
        get("model"),
        typeof args.options.auth === "string" ? args.options.auth : undefined,
        typeof args.options["secret-ref"] === "string" ? args.options["secret-ref"] : undefined,
      );
      return { state: "selected" };
    case "models configure": {
      const config = await readConfig(get("config"));
      check(get("auth") === "binding", "binding_auth_required");
      const name = get("secret-ref");
      check(
        config.runtime.models.some(
          (m) =>
            m.providerId === get("provider") &&
            "auth" in m &&
            m.auth.kind === "secretRef" &&
            m.auth.secretRef === name,
        ),
        "selected_secret_reference_required",
        3,
      );
      const prepared = await verifyPrepared(resolve(get("directory")));
      check(
        prepared.operator.deployment.origin === config.deployment.origin,
        "prepared_origin_mismatch",
        3,
      );
      check(
        !!args.options["secret-stdin"] ||
          (!args.options["non-interactive"] &&
            (!!context.interaction || (process.stdin.isTTY && process.stderr.isTTY))),
        "secret_input_required",
        3,
      );
      await port.run({
        args: ["secret", "put", name, "--config", resolve(get("directory"), "wrangler.json")],
        cwd: resolve(get("directory")),
        ...(args.options["secret-stdin"] ? { inheritInput: true } : { terminal: true }),
        deploymentAuth: true,
        signal: context.signal,
        timeoutMs,
      });
      return { state: "binding_secret_uploaded", rolloutEvidence: "must-be-renewed" };
    }
    case "models login": {
      check(!args.options["non-interactive"], "oauth_requires_user_interaction", 3);
      const prepared = await verifyPrepared(resolve(get("directory")));
      check(
        prepared.operator.runtime.models.some(
          (model) =>
            model.providerId === get("provider") &&
            "auth" in model &&
            model.auth.kind === "oauth" &&
            model.auth.providerId === get("provider"),
        ),
        "selected_oauth_provider_required",
        3,
      );
      const profile = await loadProfile(profilePath(selected, root), context.allowLoopback);
      check(
        profile.role === "admin" && profile.endpoint === prepared.operator.deployment.origin,
        "exact_origin_admin_required",
        3,
      );
      const authInteraction = interaction();
      await protectDirectory(root);
      const installation = join(root, prepared.operator.deployment.name);
      await ensureModelAuthKey(
        port,
        resolve(get("directory")),
        installation,
        profile.endpoint,
        context.signal,
      );
      await protectDirectory(installation);
      const id = await installationId(join(installation, "installation.json"));
      return loginAndIngest(
        await client(),
        get("provider"),
        authInteraction,
        id,
        get("request-id"),
      );
    }
    case "models status":
      return (await client()).call("getProviderAuthStatus", {
        path: { providerId: get("provider") },
        query: {},
        body: undefined,
      });
    case "models logout": {
      const body: ProviderAuthDelete = {
        requestId: get("request-id"),
        expectedVersion: integer(args, "expected-version"),
      };
      return (await client()).call("deleteProviderAuth", {
        path: { providerId: get("provider") },
        query: {},
        body,
      });
    }
    case "credentials create":
    case "credentials rotate": {
      const profile = await loadProfile(profilePath(selected, root), context.allowLoopback);
      return issueCredential(
        await client(),
        profile.endpoint,
        resolve(get("output")),
        (await readInput()) as Parameters<typeof issueCredential>[3],
        args.command === "credentials rotate" ? get("id") : undefined,
      );
    }
    case "export download": {
      const api = await client();
      const operation = await api.call("getAdminOperation", {
        path: { id: get("id") },
        query: {},
        body: undefined,
      });
      check(operation.state === "completed", "export_not_completed", 3);
      const artifacts = args.options["artifact-id"]
        ? operation.artifacts.filter((a) => a.artifactId === get("artifact-id"))
        : operation.artifacts;
      check(artifacts.length === 1 && artifacts[0], "select_one_export_artifact");
      return api.download(
        artifacts[0],
        resolve(get("output")),
        integer(args, "max-bytes", 1, 1073741824),
      );
    }
    case "tui":
      return launchTui(
        [...(args.options.profile ? ["--profile", selected] : []), ...args.passthrough],
        context.signal,
      );
  }
  const reads: Record<string, CommandOperation> = {
    status: "getAdminHealth",
    "config get": "getConfiguration",
    "agents list": "listAgents",
    "workspaces list": "listWorkspaces",
    "executors list": "listExecutors",
    audit: "listAudit",
    usage: "getUsage",
    "export status": "getAdminOperation",
  };
  const writes: Record<string, CommandOperation> = {
    "agents create": "createAgent",
    "agents configure": "configureAgent",
    "config apply": "patchConfiguration",
    "workspaces bind": args.options.id ? "rebindWorkspace" : "createWorkspace",
    "executors bind": args.options.id ? "rebindWorkspace" : "createWorkspace",
    "credentials revoke": "revokeCredential",
    "executors revoke": "revokeExecutor",
    "export create": "createExport",
    "export backup": "createBackup",
  };
  let operationId = reads[args.command] ?? writes[args.command];
  let path: Record<string, string> = {};
  if (args.command === "inspect") {
    const kinds: Record<string, CommandOperation> = {
      agent: "describeAgent",
      conversation: "getConversation",
      task: "describeTask",
      job: "describeJob",
      approval: "describeApproval",
    };
    operationId = kinds[get("kind")];
    check(operationId, "invalid_inspection_kind");
    path = { [get("kind") === "agent" ? "agentId" : "id"]: get("id") };
  } else if (args.options.id)
    path = {
      [args.command === "agents configure"
        ? "agentId"
        : args.command === "workspaces bind" || args.command === "executors bind"
          ? "workspaceId"
          : "id"]: get("id"),
    };
  check(operationId, "unknown_command");
  const body = writes[args.command] ? await readInput() : undefined;
  if (args.command === "executors bind")
    check(
      body &&
        typeof body === "object" &&
        (body as { config?: { kind?: unknown } }).config?.kind === "local",
      "local_workspace_binding_required",
    );
  if (args.command === "config apply") {
    check(
      body &&
        typeof body === "object" &&
        (body as { expectedVersion?: unknown }).expectedVersion ===
          integer(args, "expected-version"),
      "expected_version_mismatch",
    );
  }
  const query = ["agents list", "workspaces list", "executors list", "audit"].includes(args.command)
    ? page()
    : {};
  return (await client()).call(operationId, { path, query, body } as Omit<
    OperationRequest<typeof operationId>,
    "operationId"
  >);
}
