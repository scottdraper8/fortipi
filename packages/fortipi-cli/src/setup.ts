import { randomBytes, randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  Agent,
  AgentCreate,
  CredentialMint,
  ResourceScope,
  WorkspaceBinding,
  WorkspaceBindingCreate,
} from "fortipi-contract";
import { canonicalJson } from "fortipi-contract";
import type { AdminClient } from "./admin.js";
import { sha256, verifyAssets, verifyPrepared } from "./assets.js";
import { readConfig } from "./config.js";
import { CliError, check } from "./errors.js";
import { choices } from "./initialization.js";
import type { CliInteraction } from "./interaction-types.js";
import type { Profile } from "./profiles.js";
import {
  checkProtected,
  profilePath,
  protectDirectory,
  readProtected,
  replaceProtected,
  writeProtected,
} from "./profiles.js";
import type { CommandResult, CredentialDelivery, DeploymentReceipt } from "./results.js";
import { validate } from "./validation.js";
import type { WranglerPort } from "./wrangler.js";
import { secretNames, secretPut } from "./wrangler.js";

export async function localBootstrap(
  root: string,
  endpoint: string,
  name = "bootstrap",
): Promise<Profile> {
  check(/^[A-Za-z0-9_-]{1,64}$/.test(name), "invalid_profile");
  await protectDirectory(root);
  const path = join(root, `${name}.json`);
  try {
    const current = (await readProtected(path)) as Profile;
    check(
      current.version === 1 &&
        current.endpoint === endpoint &&
        current.role === "admin" &&
        typeof current.token === "string" &&
        /^[a-f0-9]{64}$/.test(current.token),
      "bootstrap_identity_mismatch",
      3,
    );
    return current;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const profile: Profile = {
    version: 1,
    endpoint,
    role: "admin",
    token: randomBytes(32).toString("hex"),
  };
  await writeProtected(path, profile);
  return profile;
}
export async function ensureModelAuthKey(
  port: WranglerPort,
  directory: string,
  root: string,
  endpoint: string,
  signal?: AbortSignal,
): Promise<void> {
  const names = await secretNames(port, directory, signal);
  // An unknown existing server key is preserved, regardless of local storage.
  if (names.includes("FORTIPI_MODEL_AUTH_KEY")) return;
  await protectDirectory(root);
  const path = join(root, "model-auth-key.json");
  let value: { endpoint: string; key: string };
  try {
    value = (await readProtected(path)) as typeof value;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    value = { endpoint, key: randomBytes(32).toString("base64") };
    await writeProtected(path, value);
  }
  check(
    value.endpoint === endpoint &&
      typeof value.key === "string" &&
      Buffer.from(value.key, "base64").length === 32,
    "model_auth_key_repair_required",
    3,
  );
  await secretPut(port, directory, "FORTIPI_MODEL_AUTH_KEY", {
    input: value.key,
    ...(signal ? { signal } : {}),
  });
}

interface SetupPlan {
  login: boolean;
  workspace: WorkspaceBindingCreate;
  agent: AgentCreate;
  credential: {
    requestId: string;
    role: "client" | "executor";
    executorId?: string;
    output: string;
    grantId: string;
  };
  scope: ResourceScope;
  includeAgent: boolean;
  includeWorkspace: boolean;
  providers: Record<string, string>;
}
type SetupStage =
  | "login"
  | "prepare"
  | "deploy"
  | "provider"
  | "workspace"
  | "agent"
  | "credential";
interface SetupJournal {
  version: 1;
  setupId: string;
  configPath: string;
  configSha256: string;
  directory: string;
  endpoint: string;
  assetManifestSha256: string;
  plan: SetupPlan;
  loggedIn?: true;
  prepared?: true;
  deployment?: DeploymentReceipt;
  providerReady: string[];
  workspace?: WorkspaceBinding;
  agent?: Agent;
  credential?: CredentialDelivery;
  pending?: { stage: SetupStage; requestId: string };
}
export interface SetupResult {
  state: "setup-completed" | "setup-pending" | "setup-uncertain";
  setupId: string;
  journal: string;
  reason?: string;
  requestId?: string;
  workspaceId?: string;
  agentId?: string;
  credential?: CredentialDelivery;
  rolloutEvidence: "verify-after-final-auth-setup";
  exitCode?: 1;
}
export interface SetupOptions {
  config: string;
  directory: string;
  from?: string;
  root: string;
  profile: string;
  nonInteractive: boolean;
  signal: AbortSignal;
  interaction(): CliInteraction;
  execute(args: string[]): Promise<CommandResult>;
  client(expectedOrigin: string): Promise<AdminClient>;
  port: WranglerPort;
}

async function collectPlan(options: SetupOptions): Promise<SetupPlan> {
  const ui = options.interaction();
  const ask = choices(ui);
  const config = await readConfig(options.config);
  const modelId = await ask.select(
    "Model for the first agent:",
    config.runtime.models.map((m, i) => [String(i), `${m.providerId}/${m.modelId}`]),
  );
  const model = config.runtime.models[Number(modelId)];
  check(model, "selected_model_required");
  const name = await ask.text("First agent name:");
  const recipient = await ask.text(
    "New scoped credential profile name (different from the administrator profile):",
  );
  check(recipient !== options.profile, "separate_recipient_profile_required");
  const output = profilePath(recipient, options.root);
  try {
    await lstat(output);
    throw new CliError("credential_destination_unavailable", 3);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const role = (await ask.select("Credential recipient (role alone grants no resource access):", [
    ["client", "Client"],
    ["executor", "Executor"],
  ])) as "client" | "executor";
  const executorId =
    role === "executor" ? await ask.text("Executor ID for this credential:") : undefined;
  const includeAgent =
    (await ask.select("Grant access to the new agent?", [
      ["yes", "Yes"],
      ["no", "No"],
    ])) === "yes";
  const includeWorkspace =
    (await ask.select("Grant access to the new workspace?", [
      ["yes", "Yes"],
      ["no", "No"],
    ])) === "yes";
  const scope: ResourceScope = {
    agentIds: await ask.list("Other agent IDs (comma-separated; blank for none):"),
    workspaceIds: await ask.list("Other workspace IDs (comma-separated; blank for none):"),
    conversationIds: await ask.list("Existing conversation IDs (comma-separated; blank for none):"),
    actions: await ask.list(
      "Exact allowed actions (comma-separated, e.g. agents.read,conversations.create; no implicit permissions):",
    ),
    tools: await ask.list("Exact allowed tools (comma-separated; blank grants no tools):"),
    executorIds: await ask.list("Allowed execution target IDs (comma-separated; blank for none):"),
    backendIds: await ask.list("Allowed backend IDs (comma-separated; blank for none):"),
  };
  validate("ResourceScope", scope);
  check(scope.actions.length > 0, "explicit_actions_required");
  const plan: SetupPlan = {
    login:
      (await ask.select("Cloudflare sign-in:", [
        ["login", "Sign in with Wrangler"],
        ["existing", "Use my existing Wrangler authentication"],
      ])) === "login",
    workspace: { requestId: randomUUID(), config: config.runtime.workspace },
    agent: { requestId: randomUUID(), name, model },
    credential: {
      requestId: randomUUID(),
      role,
      ...(executorId ? { executorId } : {}),
      output,
      grantId: randomUUID(),
    },
    scope,
    includeAgent,
    includeWorkspace,
    providers: Object.fromEntries(
      config.runtime.models
        .filter((m) => m.providerId !== "cloudflare")
        .map((m) => [m.providerId, randomUUID()]),
    ),
  };
  validate("WorkspaceBindingCreate", plan.workspace);
  validate("AgentCreate", plan.agent);
  if (role === "executor")
    check(executorId && /^[A-Za-z0-9_-]{1,128}$/.test(executorId), "executor_identity_required");
  await ui.notify({
    type: "info",
    message: `Create this workspace and agent, then issue exactly this scoped credential? No conversation or model work starts.\n${JSON.stringify({ workspace: plan.workspace.config, agent: { name, model }, credential: { role, recipient, executorId }, scope, includeNewAgent: includeAgent, includeNewWorkspace: includeWorkspace }, null, 2)}`,
  });
  check(
    (await ask.select("Apply this setup plan?", [
      ["yes", "Apply"],
      ["no", "Cancel"],
    ])) === "yes",
    "cancelled",
    130,
  );
  return plan;
}

/** Composes the public commands. A pending effect is never automatically replayed. */
export async function guidedSetup(options: SetupOptions): Promise<SetupResult> {
  options.config = resolve(options.config);
  options.directory = resolve(options.directory);
  // Validate assets before login, bootstrap or any account mutation.
  const assets = await verifyAssets();
  try {
    await lstat(options.config);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    await options.execute([
      "init",
      "--config",
      options.config,
      ...(options.from ? ["--from", options.from] : []),
    ]);
  }
  const config = await readConfig(options.config);
  const configHash = sha256(canonicalJson(config));
  profilePath(options.profile, options.root);
  await protectDirectory(options.root);
  const storage = join(options.root, config.deployment.name);
  await protectDirectory(storage);
  const path = join(storage, `setup-${options.profile}.json`);
  const lock = join(storage, `setup-${options.profile}.lock`);
  // Exclusive lock fails closed after a killed process; no time-based stale-lock guessing.
  await writeProtected(lock, { version: 1, processId: process.pid });
  try {
    let journal: SetupJournal;
    try {
      journal = (await readProtected(path)) as SetupJournal;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      check(!options.nonInteractive, "setup_choices_require_terminal", 3);
      const plan = await collectPlan(options);
      journal = {
        version: 1,
        setupId: randomUUID(),
        configPath: options.config,
        configSha256: configHash,
        directory: options.directory,
        endpoint: config.deployment.origin,
        assetManifestSha256: assets.manifestSha256,
        plan,
        providerReady: [],
      };
      check(Buffer.byteLength(JSON.stringify(journal)) <= 60000, "setup_plan_too_large");
      await writeProtected(path, journal);
    }
    check(
      journal.version === 1 &&
        /^[a-f0-9-]{36}$/.test(journal.setupId) &&
        journal.configPath === options.config &&
        journal.directory === options.directory &&
        journal.endpoint === config.deployment.origin &&
        journal.configSha256 === configHash &&
        journal.assetManifestSha256 === assets.manifestSha256,
      "setup_identity_changed_repair_required",
      3,
    );
    validate("WorkspaceBindingCreate", journal.plan.workspace);
    validate("AgentCreate", journal.plan.agent);
    validate("ResourceScope", journal.plan.scope);
    validate("Id", journal.plan.credential.requestId);
    validate("Id", journal.plan.credential.grantId);
    check(
      canonicalJson(journal.plan.workspace.config) === canonicalJson(config.runtime.workspace) &&
        config.runtime.models.some(
          (m) => canonicalJson(m) === canonicalJson(journal.plan.agent.model),
        ) &&
        ["client", "executor"].includes(journal.plan.credential.role) &&
        dirname(journal.plan.credential.output) === options.root &&
        journal.plan.credential.output !== profilePath(options.profile, options.root),
      "setup_plan_identity_changed",
      3,
    );
    if (journal.plan.credential.role === "executor")
      validate("Id", journal.plan.credential.executorId);
    if (journal.credential) {
      validate("CredentialRef", journal.credential.credential);
      check(
        journal.credential.role === journal.plan.credential.role &&
          journal.credential.state === "issued" &&
          Object.keys(journal.credential).sort().join() === "credential,role,state",
        "invalid_setup_credential_receipt",
        3,
      );
    }
    const save = async () => {
      check(Buffer.byteLength(JSON.stringify(journal)) <= 60000, "setup_journal_too_large");
      await replaceProtected(path, journal);
    };
    const result = (state: SetupResult["state"], reason?: string): SetupResult => ({
      state,
      setupId: journal.setupId,
      journal: path,
      rolloutEvidence: "verify-after-final-auth-setup",
      ...(state === "setup-uncertain" ? { exitCode: 1 as const } : {}),
      ...(reason ? { reason } : {}),
      ...(journal.pending ? { requestId: journal.pending.requestId } : {}),
      ...(journal.workspace ? { workspaceId: journal.workspace.workspaceId } : {}),
      ...(journal.agent ? { agentId: journal.agent.agentId } : {}),
      ...(journal.credential ? { credential: journal.credential } : {}),
    });
    if (journal.pending) {
      // Public read-only observation first. No assumption that a missing response means rollback.
      if (journal.deployment || journal.pending.stage === "deploy") {
        try {
          await (await options.client(journal.endpoint)).call("getConfiguration", {
            path: {},
            query: {},
            body: undefined,
          });
        } catch {
          /* Still uncertain; no mutation follows. */
        }
      }
      return result(
        "setup-uncertain",
        `${journal.pending.stage}_reply_or_completion_requires_reconciliation`,
      );
    }
    const effect = async (stage: SetupStage, requestId: string, fn: () => Promise<void>) => {
      options.signal.throwIfAborted();
      journal.pending = { stage, requestId };
      await save(); // Intent and exact input IDs are durable before any effect.
      try {
        await fn();
      } catch (e) {
        if (options.signal.aborted) throw e;
        return false; // Keep the durable pending identity; never retry here.
      }
      delete journal.pending;
      await save();
      return true;
    };
    if (!journal.loggedIn) {
      if (journal.plan.login) {
        check(!options.nonInteractive, "cloudflare_login_requires_terminal", 3);
        if (
          !(await effect("login", journal.setupId, async () => {
            await options.execute(["login"]);
            journal.loggedIn = true;
          }))
        )
          return result("setup-uncertain", "cloudflare_login_not_confirmed");
      } else {
        journal.loggedIn = true;
        await save();
      }
    }
    if (!journal.prepared) {
      if (
        !(await effect("prepare", journal.setupId, async () => {
          await options.execute([
            "prepare",
            "--config",
            options.config,
            "--directory",
            options.directory,
          ]);
          journal.prepared = true;
        }))
      )
        return result("setup-uncertain", "prepared_directory_requires_reconciliation");
    }
    const prepared = await verifyPrepared(options.directory);
    check(
      canonicalJson(prepared.operator) === canonicalJson(config) &&
        prepared.configSha256 === sha256(canonicalJson(config.runtime)) &&
        prepared.assetManifestSha256 === journal.assetManifestSha256,
      "setup_prepared_identity_changed",
      3,
    );
    if (!journal.deployment) {
      if (
        !(await effect("deploy", journal.setupId, async () => {
          const deployment = await options.execute([
            "deploy",
            "--directory",
            options.directory,
            "--bootstrap",
            "local",
          ]);
          check(
            "workerVersionId" in deployment && deployment.origin === journal.endpoint,
            "setup_deployment_receipt_required",
            1,
          );
          journal.deployment = deployment;
        }))
      )
        return result("setup-uncertain", "deployment_requires_reconciliation");
    }
    const api = await options.client(journal.endpoint);
    for (const model of config.runtime.models) {
      if (!("auth" in model)) continue;
      const requestId = journal.plan.providers[model.providerId];
      check(requestId, "setup_provider_identity_missing", 3);
      if (model.auth.kind === "oauth") {
        const status = await api.call("getProviderAuthStatus", {
          path: { providerId: model.providerId },
          query: {},
          body: undefined,
        });
        if (status.state !== "configured") {
          if (journal.providerReady.includes(model.providerId))
            return result("setup-pending", "provider_sign_in_no_longer_ready");
          check(!options.nonInteractive, "oauth_requires_user_interaction", 3);
          if (
            !(await effect("provider", requestId, async () => {
              await options.execute([
                "models",
                "login",
                "--provider",
                model.providerId,
                "--directory",
                options.directory,
                "--request-id",
                requestId,
              ]);
            }))
          )
            return result("setup-uncertain", "provider_sign_in_requires_reconciliation");
          const observed = await api.call("getProviderAuthStatus", {
            path: { providerId: model.providerId },
            query: {},
            body: undefined,
          });
          if (observed.state !== "configured")
            return result("setup-pending", "provider_sign_in_not_ready");
        }
      } else {
        // The existing models command delegates key entry directly to Wrangler.
        const names = await secretNames(options.port, options.directory, options.signal);
        if (!names.includes(model.auth.secretRef)) {
          if (journal.providerReady.includes(model.providerId))
            return result("setup-pending", "provider_binding_no_longer_ready");
          check(!options.nonInteractive, "provider_key_requires_terminal", 3);
          if (
            !(await effect("provider", requestId, async () => {
              await options.execute([
                "models",
                "configure",
                "--config",
                options.config,
                "--provider",
                model.providerId,
                "--auth",
                "binding",
                "--secret-ref",
                model.auth.kind === "secretRef" ? model.auth.secretRef : "",
                "--directory",
                options.directory,
              ]);
            }))
          )
            return result("setup-uncertain", "provider_binding_requires_reconciliation");
        }
      }
      if (!journal.providerReady.includes(model.providerId))
        journal.providerReady.push(model.providerId);
      await save();
    }
    const protocol = await api.call("getProtocol", { path: {}, query: {}, body: undefined });
    if (
      !config.runtime.models.every((m) =>
        protocol.models.some(
          (p) => p.providerId === m.providerId && p.modelId === m.modelId && p.available,
        ),
      )
    )
      return result("setup-pending", "selected_model_not_ready");
    const input = async (name: string, body: unknown) => {
      const target = join(storage, `setup-${options.profile}-${name}.json`);
      try {
        check(
          canonicalJson(await readProtected(target)) === canonicalJson(body),
          "setup_operation_input_changed",
          3,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        await writeProtected(target, body);
      }
      return target;
    };
    if (!journal.workspace) {
      const body = await input("workspace", journal.plan.workspace);
      if (
        !(await effect("workspace", journal.plan.workspace.requestId, async () => {
          const value = await options.execute(["workspaces", "bind", "--input", body]);
          validate("WorkspaceBinding", value);
          journal.workspace = value as WorkspaceBinding;
        }))
      )
        return result("setup-uncertain", "workspace_creation_requires_reconciliation");
    }
    if (!journal.agent) {
      const body = await input("agent", journal.plan.agent);
      if (
        !(await effect("agent", journal.plan.agent.requestId, async () => {
          const value = await options.execute(["agents", "create", "--input", body]);
          validate("Agent", value);
          journal.agent = value as Agent;
        }))
      )
        return result("setup-uncertain", "agent_creation_requires_reconciliation");
    }
    check(journal.workspace && journal.agent, "setup_resource_receipts_required", 3);
    if (!journal.credential) {
      const plan = journal.plan.credential;
      const resources = structuredClone(journal.plan.scope);
      if (journal.plan.includeAgent)
        resources.agentIds = [...new Set([...resources.agentIds, journal.agent.agentId])];
      if (journal.plan.includeWorkspace)
        resources.workspaceIds = [
          ...new Set([...resources.workspaceIds, journal.workspace.workspaceId]),
        ];
      const common = {
        requestId: plan.requestId,
        grants: [{ grantId: plan.grantId, version: 1, resources }],
      };
      if (plan.role === "executor") check(plan.executorId, "executor_identity_required");
      const mint: CredentialMint =
        plan.role === "executor"
          ? { ...common, role: "executor", executorId: plan.executorId as string }
          : { ...common, role: "client" };
      validate("CredentialMint", mint);
      const body = await input("credential", mint);
      if (
        !(await effect("credential", plan.requestId, async () => {
          const value = await options.execute([
            "credentials",
            "create",
            "--input",
            body,
            "--output",
            plan.output,
          ]);
          check(
            "credential" in value && "state" in value && value.state === "issued",
            "setup_credential_delivery_required",
            1,
          );
          const delivery = value as CredentialDelivery;
          validate("CredentialRef", delivery.credential);
          check(delivery.role === plan.role, "setup_credential_role_mismatch", 1);
          journal.credential = {
            credential: delivery.credential,
            role: delivery.role,
            state: "issued",
          };
        }))
      )
        return result(
          "setup-uncertain",
          "credential_delivery_requires_reconciliation_do_not_remint",
        );
    }
    // Fresh observations on resume, never a claim that local setup proved live execution.
    const workspace = await api.call("describeWorkspace", {
      path: { workspaceId: journal.workspace.workspaceId },
      query: {},
      body: undefined,
    });
    await api.call("describeAgent", {
      path: { agentId: journal.agent.agentId },
      query: {},
      body: undefined,
    });
    let targetsReady = true;
    if (config.runtime.execution.kind === "native" || config.runtime.workspace.kind === "local") {
      const targets = await api.call("listExecutors", {
        path: {},
        query: { limit: 100 },
        body: undefined,
      });
      const execution = config.runtime.execution;
      const local = config.runtime.workspace;
      targetsReady =
        (execution.kind !== "native" ||
          targets.items.some(
            (e) =>
              e.executorId === execution.executorId &&
              e.state === "online" &&
              e.confinement === execution.trust,
          )) &&
        (local.kind !== "local" ||
          targets.items.some(
            (e) =>
              e.executorId === local.executorId &&
              e.state === "online" &&
              e.rootBindingIds.includes(local.rootBindingId),
          ));
      // Absence from a bounded page is not evidence of readiness.
    }
    if (
      workspace.availability !== "available" ||
      !targetsReady ||
      !protocol.backends.some((b) => b.kind === config.runtime.execution.kind && b.available)
    )
      return result("setup-pending", "workspace_or_execution_target_not_ready");
    return result("setup-completed");
  } finally {
    await checkProtected(lock);
    await unlink(lock);
  }
}
