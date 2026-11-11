import { routeCatalog } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import { check } from "./store.js";

const fields = [
  "agentIds",
  "conversationIds",
  "workspaceIds",
  "actions",
  "tools",
  "executorIds",
  "backendIds",
] as const;
export const emptyScope = (): D.ResourceScope => ({
  agentIds: [],
  conversationIds: [],
  workspaceIds: [],
  actions: [],
  tools: [],
  executorIds: [],
  backendIds: [],
});
export function contains(parent: D.ResourceScope, child: D.ResourceScope): boolean {
  return fields.every((k) => {
    if (child[k].length === 0) return true;
    const allowed = new Set(parent[k]);
    return allowed.has("*") || child[k].every((value) => allowed.has(value));
  });
}
export function permits(
  grants: D.Grant[],
  resources: D.ResourceScope,
  action: string,
  now = Date.now(),
): boolean {
  const wanted = { ...resources, actions: [...resources.actions, action] };
  return grants.some(
    (g) => (g.expiresAt === undefined || now < g.expiresAt) && contains(g.resources, wanted),
  );
}
export function requireGrant(ctx: D.AuthContext, action: string, resources = emptyScope()): void {
  check(
    roleAllows(ctx, action) && permits(ctx.grants, resources, action),
    "unauthorized",
    "Grant does not authorize this operation",
  );
}
export function roleAllows(ctx: D.AuthContext, action: string): boolean {
  if (ctx.role === "executor")
    return [
      "executors.register",
      "tickets.mint",
      "transfers.input",
      "transfers.output",
      "transfers.status",
    ].includes(action);
  if (ctx.role === "admin") return true;
  // Actions may be shared by application and admin routes. Route audience checks
  // remain the caller's responsibility; this check gates action authority only.
  const routes = routeCatalog.filter((route) => route.action === action);
  return routes.length === 0 || routes.some((route) => route.audience !== "admin");
}
export function delegation(ctx: D.AuthContext, grants: D.Grant[], expiresAt?: number): void {
  requireGrant(ctx, "credentials.mint");
  check(grants.length <= 100, "invalid_request", "Too many grants");
  for (const g of grants)
    check(
      ctx.grants.some(
        (parent) =>
          (parent.expiresAt === undefined ||
            (g.expiresAt !== undefined && g.expiresAt <= parent.expiresAt)) &&
          (parent.expiresAt === undefined || Date.now() < parent.expiresAt) &&
          contains(parent.resources, g.resources),
      ),
      "unauthorized",
      "Delegation exceeds authority",
    );
  check(
    ctx.credentialExpiresAt === null ||
      (expiresAt !== undefined && expiresAt <= ctx.credentialExpiresAt),
    "unauthorized",
    "Delegation outlives issuer",
  );
}
export function credentialResources(ctx: D.AuthContext): D.ResourceScope {
  const result = emptyScope();
  for (const g of ctx.grants)
    if (g.expiresAt === undefined || g.expiresAt > Date.now())
      for (const k of fields) result[k] = [...new Set([...result[k], ...g.resources[k]])];
  return result;
}
