import type * as D from "../boundary/dto.js";
import { id, type Store } from "./store.js";
export function audit(
  store: Store,
  ctx: D.AuthContext,
  action: string,
  resourceId: string,
  disposition: D.AuditEntry["disposition"],
): void {
  const auditId = id();
  store.put("audit", auditId, {
    auditId,
    timestamp: Date.now(),
    principalId: ctx.principalId,
    action,
    resourceId,
    disposition,
  } satisfies D.AuditEntry);
}
