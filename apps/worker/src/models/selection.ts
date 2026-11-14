import { check } from "../api/common.js";
import { boundedJson, validate } from "../api/validation.js";
import type * as D from "../boundary/dto.js";

/** Existing private CP fetch. Call only after registered authority/readiness. */
export async function configuredModel(
  control: { fetch(request: Request): Promise<Response> },
  agentId: string,
  auth: D.AuthContext,
): Promise<D.ModelConfig> {
  check(
    /^[A-Za-z0-9_-]{1,128}$/.test(agentId) && auth.registrationId,
    "unauthorized",
    "Registered agent model authority required",
  );
  const signal = AbortSignal.timeout(Math.max(1, Math.min(30000, auth.deadline - Date.now())));
  const response = await control.fetch(
    new Request(`https://control.internal/internal/agents/${agentId}/model`, {
      method: "GET",
      headers: { "X-Fortipi-Context": JSON.stringify(auth) },
      signal,
    }),
  );
  check(
    response.ok,
    response.status === 401 || response.status === 403 ? "unauthorized" : "unavailable",
    "Configured model unavailable",
  );
  const selected: unknown = await boundedJson({ body: response.body, signal }, 65536);
  validate<D.ModelConfig>("ModelConfig", selected);
  return selected;
}
