import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CredentialRef, TransferDescriptor } from "fortipi-contract/executor";
import type { Binding, Limits, Profile } from "./config.js";
import {
  adapter,
  effectiveLimits,
  loadProfile,
  privateRead,
  privateWrite,
  readRegularBytes,
  stateHome,
  validateOrigin,
  validateProfile,
} from "./config.js";
import { Ledger, ledgerRegistryIdentity, rootRegistry } from "./ledger.js";
import type { PlatformAdapter } from "./platform/types.js";
import { disabledPolicy } from "./policy.js";
import { HttpTransport, validate } from "./transport.js";

interface Device {
  expectedDeploymentId: string;
  executorId: string;
  executorGeneration: number;
  resources: TransferDescriptor["consumer"];
  bindings: Binding[];
  limits?: Partial<Limits>;
}
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function object(
  value: unknown,
  required: string[],
  optional: string[] = [],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw new Error("invalid configure input");
}
/** Protected assembly only. Discovery is public; bearer authority is checked at real start. */
export async function configureProfile(
  credentialFile: string,
  inputFile: string,
  outputFile: string,
  platform: PlatformAdapter = adapter(),
  localTest = false,
  fetcher: typeof fetch = fetch,
): Promise<Profile> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(await privateRead(resolve(credentialFile), platform));
  } catch {
    throw new Error("invalid or unsafe protected issued executor envelope");
  }
  object(envelope, ["version", "endpoint", "role", "token", "credential"], ["expiresAt"]);
  if (
    envelope.version !== 1 ||
    envelope.role !== "executor" ||
    typeof envelope.endpoint !== "string" ||
    typeof envelope.token !== "string" ||
    !/^[\x21-\x7e]{16,4096}$/.test(envelope.token) ||
    (envelope.expiresAt !== undefined &&
      (!Number.isSafeInteger(envelope.expiresAt) || Number(envelope.expiresAt) <= Date.now()))
  )
    throw new Error("invalid issued executor envelope");
  const origin = validateOrigin(envelope.endpoint, localTest);
  if (envelope.endpoint !== origin) throw new Error("canonical credential endpoint required");
  const credential = validate<CredentialRef>(
    "common.schema.json",
    "CredentialRef",
    envelope.credential,
  );
  let raw: unknown;
  try {
    raw = JSON.parse((await readRegularBytes(resolve(inputFile))).toString("utf8"));
  } catch {
    throw new Error("invalid or unsafe executor device input");
  }
  object(
    raw,
    ["expectedDeploymentId", "executorId", "executorGeneration", "resources", "bindings"],
    ["limits"],
  );
  if (
    !id(raw.expectedDeploymentId) ||
    !id(raw.executorId) ||
    !Number.isSafeInteger(raw.executorGeneration) ||
    Number(raw.executorGeneration) < 1 ||
    !Array.isArray(raw.bindings) ||
    raw.bindings.length > 100
  )
    throw new Error("invalid executor device selection");
  validate("common.schema.json", "ResourceScope", raw.resources);
  if (raw.limits !== undefined) object(raw.limits, [], Object.keys(effectiveLimits()));
  const device = raw as unknown as Device;
  const limits = effectiveLimits(device.limits ?? {});
  const roots = new Set<string>(),
    workspaces = new Set<string>(),
    paths = new Set<string>();
  for (const value of device.bindings) {
    object(value, [
      "rootBindingId",
      "workspaceId",
      "bindingVersion",
      "path",
      "revision",
      "manifestHash",
      "providerKind",
    ]);
    if (
      !id(value.rootBindingId) ||
      !id(value.workspaceId) ||
      !Number.isSafeInteger(value.bindingVersion) ||
      Number(value.bindingVersion) < 1 ||
      !id(value.revision) ||
      typeof value.manifestHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.manifestHash) ||
      !["local", "computer"].includes(String(value.providerKind)) ||
      typeof value.path !== "string" ||
      resolve(value.path) !== value.path ||
      (await realpath(value.path)) !== value.path ||
      !(await lstat(value.path)).isDirectory() ||
      roots.has(value.rootBindingId) ||
      workspaces.has(value.workspaceId) ||
      paths.has(value.path) ||
      !device.resources.workspaceIds.includes(value.workspaceId)
    )
      throw new Error("invalid explicit workspace binding");
    await platform.verifyEntry(value.path, await lstat(value.path));
    roots.add(value.rootBindingId);
    workspaces.add(value.workspaceId);
    paths.add(value.path);
  }
  if (!device.resources.executorIds.includes(device.executorId))
    throw new Error("executor outside selected resources");
  const profile: Profile = {
    version: 1,
    origin,
    deploymentId: device.expectedDeploymentId,
    executorId: device.executorId,
    executorGeneration: device.executorGeneration,
    credential,
    token: envelope.token,
    ...(envelope.expiresAt === undefined
      ? {}
      : { credentialExpiresAt: Number(envelope.expiresAt) }),
    ledgerId: randomUUID(),
    bindings: device.bindings,
    resources: device.resources,
    policy: structuredClone(disabledPolicy),
    limits,
  };
  const path = resolve(outputFile);
  // Validate containment/checkouts before writing any bearer at the requested destination.
  await platform.verifyProtection(dirname(path), true);
  if ((await realpath(dirname(path))) !== dirname(path)) throw new Error("private parent alias");
  await validateProfile(profile, path, localTest);
  try {
    await new HttpTransport(profile, fetcher, localTest).discover();
  } catch {
    throw new Error("incompatible or unavailable deployment/protocol");
  }
  await privateWrite(path, JSON.stringify(profile), platform, true);
  return loadProfile(path, platform, localTest);
}

/** The init command's registry-before-provision ordering, with a disposable registry port for qualification. */
export async function initializeProfile(
  profile: Profile,
  directory: string,
  platform = adapter(),
  registry = join(stateHome(), "roots"),
): Promise<void> {
  const guards = await rootRegistry(
    registry,
    [],
    platform,
    ledgerRegistryIdentity(profile, directory, "provision"),
  );
  for (const guard of guards) guard.close();
  const ledger = await Ledger.provision(
    directory,
    profile.ledgerId,
    effectiveLimits(profile.limits),
    platform,
  );
  ledger.close();
}
