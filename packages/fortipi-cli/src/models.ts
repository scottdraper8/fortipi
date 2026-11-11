import { randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import type { ModelConfig } from "fortipi-contract";
import { readConfig, writeConfig } from "./config.js";
import { check } from "./errors.js";
import { providerFactory, supportedOAuth } from "./model-auth.js";
import type { CatalogModel } from "./results.js";

export function localModels(providerId?: string): CatalogModel[] {
  check(
    providerId === undefined ||
      providerId === "cloudflare" ||
      supportedOAuth.some((id) => id === providerId),
    "unsupported_model_provider",
    3,
  );
  const providers = providerId === "cloudflare" ? [] : providerId ? [providerId] : supportedOAuth;
  return providers.flatMap((id) =>
    providerFactory(id)
      .getModels()
      .map((model) => ({
        providerId: id,
        modelId: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: model.input,
      })),
  );
}
export async function selectModel(
  path: string,
  providerId: string,
  modelId: string,
  auth?: string,
  secretRef?: string,
): Promise<void> {
  const config = await readConfig(path);
  check(
    providerId === "cloudflare" ||
      providerFactory(providerId)
        .getModels()
        .some((m) => m.id === modelId),
    "unknown_pinned_model",
    3,
  );
  let model: ModelConfig;
  if (providerId === "cloudflare") {
    check(!auth && !secretRef, "workers_ai_needs_no_key");
    model = { providerId, modelId };
  } else if (auth === "binding") {
    check(secretRef, "secret_reference_required");
    model = { providerId, modelId, auth: { kind: "secretRef", secretRef } };
  } else {
    check(auth === "oauth" && !secretRef, "explicit_model_auth_required");
    model = { providerId, modelId, auth: { kind: "oauth", providerId } };
  }
  config.runtime.models = [
    model,
    ...config.runtime.models.filter((m) => m.providerId !== providerId),
  ];
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeConfig(temp, config);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
