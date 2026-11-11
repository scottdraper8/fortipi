import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { check } from "./errors.js";
import type { Profile } from "./profiles.js";
import { protectDirectory, readProtected, writeProtected } from "./profiles.js";
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
