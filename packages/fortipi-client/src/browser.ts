import { FortiPiClient as Client } from "./client.js";
import type { ClientOptions } from "./types.js";
/** No Node imports, runtime checks or credential I/O on import. */
export class FortiPiClient extends Client {
  constructor(options: ClientOptions) {
    super({
      ...options,
      originMode:
        options.originMode ??
        (typeof location === "object"
          ? { kind: "browser", origin: location.origin }
          : { kind: "native" }),
    });
  }
}
export { AppliedCursor, cursorScopeKey } from "./cursor.js";
export { FortiPiError } from "./errors.js";
export type { Subscription, SubscriptionOptions } from "./subscription.js";
export type * from "./types.js";
