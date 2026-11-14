import type { WorkspaceRuntimeResult } from "@cloudflare/computer";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import type { RuntimeHostContext } from "../boundary/infrastructure.js";
import { same } from "../workspace/authority.js";
import { requireThat } from "../workspace/errors.js";
import { limitedStream } from "../workspace/streams.js";
import type { WorkspaceObject } from "../workspace/workspace-object.js";

export type NativeContext = RuntimeHostContext;
interface StopIntent {
  assignmentDigest: string;
  context: NativeContext;
  request: D.RuntimeQuiesceRequest;
}
type Owner = Pick<WorkspaceObject, "state" | "mutex">;
export function validQuiescence(value: unknown): value is D.RuntimeQuiescence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).sort().join(",") === "imageDigest,observedAt,requestId,runtimeId,stopped" &&
    typeof row.requestId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(row.requestId) &&
    typeof row.runtimeId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(row.runtimeId) &&
    typeof row.imageDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(row.imageDigest) &&
    row.stopped === true &&
    typeof row.observedAt === "number" &&
    Number.isSafeInteger(row.observedAt) &&
    row.observedAt >= 0 &&
    row.observedAt <= Date.now()
  );
}

/** Actual terminal/sync proof and the ORIGINAL captured host/image precede any stop effect. */
export async function quiesceNative(
  owner: Owner,
  env: Env,
  identity: D.ExecutionIdentity,
  result: WorkspaceRuntimeResult<"utf8">,
  runtimeId: string | undefined,
): Promise<D.RuntimeQuiescence> {
  const intent = await owner.mutex.run(() =>
    owner.state.transaction(() => {
      const context = owner.state.get<NativeContext>("scratch-native-context");
      const allocation = owner.state.get<D.StoreState>("child")?.allocation;
      requireThat(
        context &&
          runtimeId &&
          allocation?.role === "scratch" &&
          allocation.jobId === identity.jobId &&
          allocation.executionId === identity.executionId &&
          allocation.operationDigest === identity.operationDigest &&
          allocation.baseRevision === identity.baseRevision &&
          allocation.generation === identity.lease.executorGeneration &&
          owner.state.get("scratch-start") === identity.assignmentDigest &&
          result.sync.status === "complete" &&
          result.sync.skipped.length === 0 &&
          result.skipped.length === 0,
        "interrupted",
        "Known native terminal/sync/context identity required; retain active allocation",
      );
      const prior = owner.state.get<StopIntent>("scratch-stop-intent");
      if (prior) {
        requireThat(
          prior.assignmentDigest === identity.assignmentDigest &&
            same(prior.context, context) &&
            prior.request.runtimeId === runtimeId &&
            prior.request.imageDigest === context.imageDigest,
          "conflict",
          "Immutable native stop intent changed",
        );
        return prior;
      }
      const value: StopIntent = {
        assignmentDigest: identity.assignmentDigest,
        context,
        request: { requestId: crypto.randomUUID(), runtimeId, imageDigest: context.imageDigest },
      };
      // Computer mutations, runtime starts and callbacks reject this durable fence immediately.
      owner.state.put("scratch-stop-intent", value);
      return value;
    }),
  );
  const saved = owner.state.get<D.RuntimeQuiescence>("scratch-stop-receipt");
  if (saved) {
    requireThat(
      validQuiescence(saved) &&
        same(
          {
            requestId: saved.requestId,
            runtimeId: saved.runtimeId,
            imageDigest: saved.imageDigest,
          },
          intent.request,
        ),
      "conflict",
      "Retained stopped receipt mismatch",
    );
    return saved;
  }
  const hosts = env.LINUX_CONTAINERS;
  requireThat(
    hosts,
    "interrupted",
    "Original native host binding unavailable; retain active allocation",
  );
  const response = await hosts.getByName(intent.context.hostId).fetch(
    new Request("https://container.internal/__fortipi/runtime-quiesce", {
      method: "POST",
      body: JSON.stringify(intent.request),
      signal: AbortSignal.timeout(10_000),
    }),
  );
  requireThat(
    response.ok && response.body,
    "interrupted",
    "Native stop is unresolved; retain active allocation",
  );
  const receipt: unknown = await new Response(
    limitedStream(response.body, 65_536, Date.now() + 10_000, false),
  ).json();
  requireThat(
    validQuiescence(receipt) &&
      receipt.requestId === intent.request.requestId &&
      receipt.runtimeId === intent.request.runtimeId &&
      receipt.imageDigest === intent.request.imageDigest,
    "interrupted",
    "Native stopped receipt does not match retained intent",
  );
  return owner.mutex.run(() => {
    requireThat(
      same(owner.state.get("scratch-stop-intent"), intent),
      "conflict",
      "Native stop intent changed after await",
    );
    owner.state.put("scratch-stop-receipt", receipt);
    return receipt;
  });
}
