import type { Authority } from "../agent/authority.js";
import { unwrap } from "../api/common.js";
import type * as D from "../boundary/dto.js";
export type ToolContext = D.CurrentToolContext;
export async function currentToolContext(
  authority: Authority,
  auth: D.AuthContext,
  input: D.ToolContextRequest,
): Promise<ToolContext> {
  return unwrap(await authority.control.toolTopology(auth, input));
}
