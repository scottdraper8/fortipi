/** Only these provider/API-key pairs are resolved by the Worker model factory. */
export function canonicalModelSecretRef(
  providerId: string,
): "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | undefined {
  if (providerId === "openai") return "OPENAI_API_KEY";
  if (providerId === "anthropic") return "ANTHROPIC_API_KEY";
  return undefined;
}

export function isCanonicalModelSecretRef(
  providerId: string,
  secretRef: string,
): secretRef is "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" {
  return canonicalModelSecretRef(providerId) === secretRef;
}
