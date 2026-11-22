import { same } from "../api/common.js";
import type * as D from "../boundary/dto.js";
import type { RoutingStrategy } from "../boundary/policy.js";

/** Candidates have already passed current authority checks. Preference never supplies authority. */
export const configuredRouting: RoutingStrategy = {
  contractVersion: "1.0",
  select(input: D.RoutingInput): D.RoutingDecision {
    const preference = input.preference ?? { kind: "explicit", targetIds: [] };
    const ranks = new Map<string, number>();
    for (const [index, id] of preference.targetIds.entries())
      if (!ranks.has(id)) ranks.set(id, index);
    const required = [...new Set([input.operation.tool, ...input.operation.capabilities])];
    const id = (target: D.BackendRef) =>
      target.kind === "executor" ? target.executorId : target.backendId;
    const rank = (target: D.BackendRef) => ranks.get(id(target)) ?? preference.targetIds.length;
    const local = (target: D.BackendRef) =>
      preference.kind === "prefer-local" && target.kind === "backend" ? 1 : 0;
    const less = (a: D.BackendRef, b: D.BackendRef) =>
      local(a) !== local(b)
        ? local(a) < local(b)
        : rank(a) !== rank(b)
          ? rank(a) < rank(b)
          : id(a) !== id(b)
            ? id(a) < id(b)
            : a.kind !== b.kind
              ? a.kind < b.kind
              : a.generation < b.generation;
    let best: D.BackendRef | undefined;
    for (const candidate of input.eligible) {
      const capabilities = new Set(candidate.capabilities);
      if (
        !candidate.reachable ||
        !candidate.revisionCompatible ||
        !required.every((c) => capabilities.has(c))
      )
        continue;
      const target = candidate.target;
      if (input.explicitTarget) {
        if (same(target, input.explicitTarget)) return { kind: "selected", target };
        continue;
      }
      if (
        (preference.kind === "cloud" && target.kind !== "backend") ||
        (preference.kind === "explicit" && !ranks.has(id(target)))
      )
        continue;
      if (!best || less(target, best)) best = target;
    }
    return best
      ? { kind: "selected", target: best }
      : {
          kind: "deny",
          reason: input.explicitTarget
            ? "Explicit target is not currently eligible"
            : "No currently eligible configured target; choose an explicit target or update routing",
        };
  },
};
