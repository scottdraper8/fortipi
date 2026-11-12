import type { Store } from "../agent/store.js";
import { check, same } from "../api/common.js";
import { validate } from "../api/validation.js";
import type * as D from "../boundary/dto.js";

/** Restore only nonsecret service-owned configuration; never infer a provider from environment keys. */
export async function retainedModelConfigurations(
  store: Store,
  selected?: D.ModelConfig,
  includeStoredSelection = true,
): Promise<{
  catalog: D.ModelConfig[];
  configurations: D.ModelConfig[];
  selected: D.ModelConfig | undefined;
}> {
  return store.transaction(async (tx) => {
    // Historical catalog entries are not requirements. Only the current
    // selection and persisted unfinished work may require provider auth.
    const catalog = new Map<string, D.ModelConfig>();
    const current =
      selected ??
      (includeStoredSelection
        ? await store.get<D.ModelConfig>("meta", "selected-model", tx)
        : undefined);
    if (current) {
      validate<D.ModelConfig>("ModelConfig", current);
      catalog.set(current.providerId, current);
    }
    // These are OWN indexed records, not Pi tables. Include admitted/queued and
    // allocation-gap work even when the last selected provider is different.
    const pending = await tx.all<{ model: string }>(
      `SELECT json_extract(data,'$.model') AS model FROM fp_records_v1
       WHERE (kind='admission' AND json_extract(data,'$.state') IN ('pending','accepted','settlement_pending'))
          OR (kind='creation' AND json_extract(data,'$.state') IN ('pending','allocated') AND json_extract(data,'$.model') IS NOT NULL)
          OR (kind='admission-intent' AND json_extract(data,'$.state')='pending' AND json_extract(data,'$.model') IS NOT NULL)
       GROUP BY model LIMIT 33`,
    );
    const configurations = [...catalog.values()];
    for (const row of pending) {
      const config: unknown = JSON.parse(row.model);
      validate<D.ModelConfig>("ModelConfig", config);
      const provider = catalog.get(config.providerId);
      if (provider)
        check(
          same("auth" in provider ? provider.auth : null, "auth" in config ? config.auth : null) &&
            same(
              "endpoint" in provider ? (provider.endpoint ?? null) : null,
              "endpoint" in config ? (config.endpoint ?? null) : null,
            ),
          "conflict",
          "Outstanding work retains a different authentication configuration for this provider",
        );
      else catalog.set(config.providerId, config);
      if (!configurations.some((known) => same(known, config))) configurations.push(config);
    }
    check(
      catalog.size <= 4 && configurations.length <= 32,
      "conflict",
      "Retained model configuration bound exceeded",
    );
    return { catalog: [...catalog.values()], configurations, selected: current };
  });
}
