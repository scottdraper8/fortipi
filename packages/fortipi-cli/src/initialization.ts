import { join } from "node:path";
import type { BackendConfig, InfrastructurePolicy, ModelConfig } from "fortipi-contract";
import { operatorConfig, readConfig, readJson, writeConfig } from "./config.js";
import { check } from "./errors.js";
import type { CliInteraction } from "./interaction-types.js";
import { localModels } from "./models.js";
import { validate } from "./validation.js";
import { cliPackageRoot } from "./wrangler.js";

/** Non-secret operator choices only. Provider secrets belong to Wrangler/Pi. */
export function choices(interaction: CliInteraction) {
  const text = async (message: string) => {
    interaction.signal?.throwIfAborted();
    return (await interaction.prompt({ type: "text", message })).trim();
  };
  const select = async (message: string, options: [string, string][]) => {
    interaction.signal?.throwIfAborted();
    const value = await interaction.prompt({
      type: "select",
      message,
      options: options.map(([id, label]) => ({ id, label })),
    });
    check(
      options.some(([id]) => id === value),
      "invalid_setup_choice",
    );
    return value;
  };
  const list = async (message: string) => {
    const value = await text(message);
    const items = value ? value.split(",").map((s) => s.trim()) : [];
    check(
      items.length <= 100 && items.every((s) => /^[A-Za-z0-9_.@/-]{1,128}$/.test(s)),
      "invalid_setup_scope",
    );
    check(new Set(items).size === items.length, "duplicate_setup_scope");
    return items;
  };
  return { text, select, list };
}

export async function initialize(
  path: string,
  options: { from?: string; interaction: () => CliInteraction },
): Promise<void> {
  if (options.from) {
    await writeConfig(path, await readConfig(options.from));
    return;
  }
  const interaction = options.interaction();
  const ask = choices(interaction);
  const config = await readConfig(join(cliPackageRoot, "templates/operator-config.example.json"));
  config.deployment.name = await ask.text(
    "Deployment name (lowercase letters, digits and hyphens):",
  );
  config.deployment.origin = await ask.text("Exact HTTPS Worker origin:");
  const accountId = await ask.text(
    "Cloudflare account ID (optional; blank uses Wrangler's account selection):",
  );
  if (accountId) config.deployment.accountId = accountId;
  const providerId = await ask.select("Model provider:", [
    ["cloudflare", "Workers AI (no provider key)"],
    ["openai", "OpenAI"],
    ["anthropic", "Anthropic"],
    ["openai-codex", "OpenAI Codex (OAuth)"],
  ]);
  const modelId = await ask.text(
    "Model ID (choose a supported model from 'fortipi models list' or the deployed Workers AI catalog):",
  );
  let model: ModelConfig;
  if (providerId === "cloudflare") model = { providerId, modelId };
  else {
    check(
      localModels(providerId).some((m) => m.modelId === modelId),
      "unknown_pinned_model",
      3,
    );
    const auth =
      providerId === "openai-codex"
        ? "oauth"
        : await ask.select("Provider authentication:", [
            ["oauth", "Supported Pi sign-in"],
            ["binding", "API key entered later through Wrangler"],
          ]);
    model =
      auth === "oauth"
        ? { providerId, modelId, auth: { kind: "oauth", providerId } }
        : {
            providerId,
            modelId,
            auth: {
              kind: "secretRef",
              secretRef: await ask.text("Provider secret binding name (not its value):"),
            },
          };
  }
  config.runtime.models = [model];
  const workspace = await ask.select("Workspace storage (independent of execution):", [
    ["computer", "Cloud Computer workspace"],
    ["local", "Registered local workspace"],
  ]);
  config.runtime.workspace =
    workspace === "computer"
      ? { kind: "computer" }
      : {
          kind: "local",
          executorId: await ask.text("Workspace executor ID:"),
          rootBindingId: await ask.text("Workspace root binding ID:"),
        };
  const execution = await ask.select(
    "Execution backend (Free keeps Loader and Containers disabled):",
    [
      ["native", "Authorized native executor (Free compatible)"],
      ["cloud-js", "Cloud JavaScript; requires an explicit verified Paid Loader capability"],
      ["linux", "Linux; requires an explicit verified Paid Containers capability"],
    ],
  );
  if (execution === "native") {
    config.runtime.execution = {
      kind: "native",
      executorId: await ask.text("Execution executor ID (may differ from workspace):"),
      trust: (await ask.select("Registered executor confinement:", [
        ["host", "Host"],
        ["isolated", "Isolated"],
      ])) as "host" | "isolated",
    };
  } else {
    const policy = await readJson(
      await ask.text(
        "Path to your existing verified infrastructure policy JSON (no plan upgrade occurs):",
      ),
    );
    validate("InfrastructurePolicy", policy);
    config.runtime.infrastructure = policy as InfrastructurePolicy;
    const backend = await readJson(
      await ask.text("Path to your selected backend configuration JSON:"),
    );
    validate("BackendConfig", backend);
    check((backend as BackendConfig).kind === execution, "selected_backend_mismatch");
    config.runtime.execution = backend as BackendConfig;
  }
  config.runtime.routing = {
    kind: (await ask.select("Routing preference (does not grant execution authority):", [
      ["explicit", "Explicit targets"],
      ["prefer-local", "Prefer local"],
      ["cloud", "Cloud"],
    ])) as "explicit" | "prefer-local" | "cloud",
    targetIds: await ask.list("Routing target IDs, comma-separated (blank for none):"),
  };
  operatorConfig(config);
  await interaction.notify({ type: "info", message: JSON.stringify(config, null, 2) });
  check(
    (await ask.select("Write this configuration?", [
      ["yes", "Write"],
      ["no", "Cancel"],
    ])) === "yes",
    "cancelled",
    130,
  );
  await writeConfig(path, config);
}
