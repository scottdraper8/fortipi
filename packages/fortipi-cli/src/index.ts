import { join, resolve } from "node:path";
import type { OperationRequest, ProviderAuthDelete } from "fortipi-contract";
import { AdminClient } from "./admin.js";
import { argv, help, integer, required } from "./argv.js";
import { prepare, verifyPrepared } from "./assets.js";
import { readConfig, readJson, writeConfig } from "./config.js";
import { issueCredential } from "./credentials.js";
import { deploy } from "./deployment.js";
import { CliError, check } from "./errors.js";
import { terminalInteraction } from "./interaction.js";
import { installationId, loginAndIngest } from "./model-auth.js";
import { localModels, selectModel } from "./models.js";
import { loadProfile, profilePath, profileRoot, protectDirectory } from "./profiles.js";
import type { CommandOperation, CommandResult } from "./results.js";
import { ensureModelAuthKey } from "./setup.js";
import { launchTui } from "./tui.js";
import { wrangler } from "./wrangler.js";

export { AdminClient } from "./admin.js";
export type { PrepareReceipt } from "./assets.js";
export type { OperatorConfig } from "./config.js";
export { operatorConfig, readConfig } from "./config.js";
export { CliError } from "./errors.js";
export type {
  CatalogModel,
  CommandResult,
  CredentialDelivery,
  DeploymentReceipt,
} from "./results.js";
export interface CommandContext {
  signal: AbortSignal;
  profileDirectory?: string;
  allowLoopback?: boolean;
}
export async function runCommand(input: string[], context: CommandContext): Promise<CommandResult> {
  const args = argv(input);
  if (args.options.help) return { help: help(args.command) };
  const get = (key: string) => required(args, key);
  const timeoutMs = args.options["timeout-ms"] ? integer(args, "timeout-ms", 1, 600000) : 30000;
  const root = context.profileDirectory ?? profileRoot();
  const selected = typeof args.options.profile === "string" ? args.options.profile : "default";
  const client = async () =>
    new AdminClient(await loadProfile(profilePath(selected, root), context.allowLoopback), {
      signal: context.signal,
      timeoutMs,
      ...(context.allowLoopback ? { allowLoopback: true } : {}),
    });
  const readInput = async () => readJson(get("input"));
  const page = () => ({
    ...(args.options.limit ? { limit: integer(args, "limit", 1, 100) } : {}),
    ...(args.options["page-token"] ? { pageToken: get("page-token") } : {}),
  });
  switch (args.command) {
    case "init": {
      // A complete canonical input makes independent workspace/execution/model choices explicit.
      check(args.options.from, "canonical_from_config_required", 3);
      await writeConfig(resolve(get("config")), await readConfig(get("from")));
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
      check(
        !args.options["non-interactive"] && process.stdin.isTTY,
        "cloudflare_login_requires_terminal",
        3,
      );
      await wrangler.run({
        args: ["login"],
        cwd: resolve("."),
        terminal: true,
        deploymentAuth: true,
        signal: context.signal,
        timeoutMs,
      });
      return { state: "cloudflare_login_completed" };
    case "prepare":
      return prepare(get("config"), get("directory"));
    case "deploy": {
      check(
        !args.options.bootstrap || ["local", "existing"].includes(get("bootstrap")),
        "invalid_bootstrap_mode",
      );
      return deploy(get("directory"), {
        dryRun: !!args.options["dry-run"],
        bootstrap: (args.options.bootstrap ?? "local") as "local" | "existing",
        nonInteractive: !!args.options["non-interactive"],
        profileName: selected,
        signal: context.signal,
        timeoutMs,
      });
    }
    case "setup":
      // Asset qualification is a prerequisite before any login or bootstrap mutation.
      await prepare(get("config"), get("directory"));
      throw new CliError("setup_resource_grants_and_service5_qualification_required", 3);
    case "models list":
      return {
        items: localModels(
          typeof args.options.provider === "string" ? args.options.provider : undefined,
        ),
        workersAi: { providerId: "cloudflare", catalog: "deployed-protocol", auth: "AI-binding" },
      };
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
            process.stdin.isTTY &&
            process.stdout.isTTY &&
            process.stderr.isTTY),
        "secret_input_required",
        3,
      );
      await wrangler.run({
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
      const interaction = terminalInteraction(context.signal);
      await protectDirectory(root);
      const installation = join(root, prepared.operator.deployment.name);
      await ensureModelAuthKey(
        wrangler,
        resolve(get("directory")),
        installation,
        profile.endpoint,
        context.signal,
      );
      await protectDirectory(installation);
      const id = await installationId(join(installation, "installation.json"));
      return loginAndIngest(await client(), get("provider"), interaction, id, get("request-id"));
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
    case "executors bind":
      throw new CliError("executor_binding_requires_explicit_workspace_binding_contract", 3);
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
        : args.command === "workspaces bind"
          ? "workspaceId"
          : "id"]: get("id"),
    };
  check(operationId, "unknown_command");
  const body = writes[args.command] ? await readInput() : undefined;
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
