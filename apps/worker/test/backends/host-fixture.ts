import { createHash } from "node:crypto";
import type { RuntimeHostContext } from "../../src/boundary/infrastructure.js";
import type { HostProbe } from "./host-rpc-worker.js";

/** Controlled standalone context, not evidence of a parent Workspace allocation. */
export async function fixtureHost(namespace: DurableObjectNamespace<HostProbe>, name: string) {
  const hex = createHash("sha256").update(name).digest("hex");
  const childId = `fortipi:child:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const hostId = `fortipi:linux:fixture:${namespace.idFromName(childId).toString()}`;
  const host = namespace.getByName(hostId);
  await host.seedFixtureContext({
    hostId,
    childId,
    authorityId: "fixture",
    allocationId: hex,
    imageDigest: `sha256:${"a".repeat(64)}`,
    ownershipNonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
  } satisfies RuntimeHostContext);
  return host;
}
