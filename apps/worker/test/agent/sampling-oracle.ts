import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Authority } from "../../src/agent/authority.js";
import { PhysicalStorage } from "../../src/agent/physical-storage.js";
import type { Store } from "../../src/agent/store.js";
import { same, scope } from "../../src/api/common.js";
import type * as D from "../../src/boundary/dto.js";
import type { StorageSampleInput } from "../../src/boundary/infrastructure.js";

const sampledDoc = defineDoc({
  kind: "fortipi.sample-oracle",
  version: 1,
  scope: "session",
  initial: () => ({ text: "" }),
  checkpointWhen: () => true,
});

/** Real queued SQLite/Pi barrier; ONLY the private sample HTTP responder is synthetic. */
export async function samplingOracle(
  store: Store,
  authority: Authority,
  harness: Harness,
  auth: D.AuthContext,
  completedReservationId: string,
) {
  const inputs: StorageSampleInput[] = [];
  let mode: "lost" | "success" | "malformed" | "revoke" = "lost";
  const sampler = new PhysicalStorage(store, authority, {
    fetch: async (request) => {
      const input = (await request.json()) as StorageSampleInput;
      inputs.push(input);
      if (mode === "lost") throw new Error("Lost sample response after send");
      if (mode === "revoke")
        await store.put("credential-floor", auth.credentialId, auth.generation + 1);
      return Response.json({
        ok: true,
        value: {
          sampleSeq: input.sampleSeq + (mode === "malformed" ? 1 : 0),
          chargeBytes: Math.max(134217728, input.coverage.bytes),
        },
      });
    },
  });
  const resources = scope({ agentIds: [authority.agentId], actions: ["conversations.create"] });
  await sampler.completed(completedReservationId);
  await harness.commit(async (tx) => {
    (await tx.doc(sampledDoc)).text = "seed";
  }, BACKGROUND_CONTEXT);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const appWrite = store.transaction(async (tx) => {
    entered.resolve();
    await release.promise;
    await store.put("sample-oracle", "before-barrier", "x".repeat(98304), tx);
  });
  await entered.promise;
  const piWrite = harness.commit(async (tx) => {
    (await tx.doc(sampledDoc)).text = "y".repeat(98304);
  }, BACKGROUND_CONTEXT);
  // Pi's public commit is enqueued behind the held app transaction. The sample
  // cannot bypass either writer through an independent raw SQLite transaction.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const precedingSize = store.transaction(async () => store.physicalBytes());
  const lost = sampler.beforeGrowth(auth, resources).then(
    () => "unexpected-success",
    () => "lost-response",
  );
  release.resolve();
  await Promise.all([appWrite, piWrite]);
  const beforeReport = await precedingSize;
  const disposition = await lost;
  const retained = await store.get("storage-completed", completedReservationId);
  mode = "success";
  await sampler.beforeGrowth(auth, resources);
  const replayed = same(inputs[0], inputs[1]);
  const covered = !(await store.get("storage-completed", completedReservationId));
  await store.put("sample-oracle", "after-barrier", "z".repeat(98304));
  await sampler.beforeGrowth(auth, resources);
  const newer = inputs[2];
  mode = "malformed";
  const malformed = await sampler.beforeGrowth(auth, resources).then(
    () => false,
    () => true,
  );
  const pending = await store.get<{ input: StorageSampleInput; receipt?: unknown }>(
    "meta",
    "storage-report",
  );
  mode = "revoke";
  const revoked = await sampler.beforeGrowth(auth, resources).then(
    () => false,
    () => true,
  );
  const final = await store.get<{ input: StorageSampleInput; receipt?: unknown }>(
    "meta",
    "storage-report",
  );
  return {
    disposition,
    lostRetainsClaim: !!retained,
    replayed,
    covered,
    beforeReport,
    first: inputs[0],
    newer,
    malformed,
    malformedRetainsUnacknowledged: !pending?.receipt,
    revoked,
    revokedRetainsUnacknowledged: !final?.receipt,
  };
}
