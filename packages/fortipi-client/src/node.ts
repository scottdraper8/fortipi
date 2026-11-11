import { FortiPiClient as Client } from "./client.js";
import type { ClientOptions, CredentialProvider } from "./types.js";
export class FortiPiClient extends Client {
  constructor(options: ClientOptions) {
    super({ ...options, originMode: options.originMode ?? { kind: "native" } });
  }
}
/** Lazy adapter: the application owns safe file/keychain acquisition; import performs no reads. */
export function credentialProvider(
  read: (signal: AbortSignal) => Promise<string>,
): CredentialProvider {
  return ({ signal }) => read(signal);
}
export { AppliedCursor, cursorScopeKey } from "./cursor.js";
export { FortiPiError } from "./errors.js";
export type { Subscription, SubscriptionOptions } from "./subscription.js";
export type * from "./types.js";
