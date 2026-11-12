// The producer resolves this import to the independently installed browser export.
import {
  FortiPiClient,
  FortiPiError,
  type Subscription,
} from "../../packages/fortipi-client/dist/browser.js";
import { publicFlow } from "./public-flow.ts";

export interface BrowserInput {
  endpoint: string;
  token: string;
  agentId: string;
  conversationId: string;
  seed: 1010;
}
export interface BrowserPort {
  run(input: BrowserInput): Promise<Record<string, unknown>>;
  arm(input: BrowserInput): Promise<void>;
  revoked(): Promise<Record<string, unknown>>;
  denied(input: BrowserInput): Promise<Record<string, unknown>>;
}
const client = (input: BrowserInput) =>
  new FortiPiClient({ endpoint: input.endpoint, credentials: async () => input.token });
let active:
  | { client: FortiPiClient; input: BrowserInput; subscription: Subscription; closed: boolean }
  | undefined;
const port: BrowserPort = {
  async run(input: BrowserInput) {
    // Native default fetch/WebSocket and browser Origin; no injected headers or transport.
    return publicFlow(client(input), client(input), input);
  },
  async arm(input) {
    if (active) throw new Error("Previous browser access observer remains active");
    const connection = client(input);
    const subscription = connection.conversations.subscribe(input.conversationId, {
      agentId: input.agentId,
      maxReconnects: 0,
      onSnapshot() {},
      onEvent() {},
    });
    const state = { client: connection, input, subscription, closed: false };
    active = state;
    void subscription.done.then(
      () => {
        state.closed = true;
      },
      () => {
        state.closed = true;
      },
    );
    await subscription.ready;
  },
  async revoked() {
    const state = active;
    if (!state) throw new Error("Actual browser subscription was not acknowledged");
    try {
      const end = Date.now() + 15000;
      while (!state.closed && Date.now() < end)
        await new Promise<void>((accept) => setTimeout(accept, 25));
      if (!state.closed) throw new Error("Actual browser access did not close on revocation");
      let failure: FortiPiError | undefined;
      try {
        await state.client.conversations.get(state.input.conversationId);
      } catch (error) {
        if (error instanceof FortiPiError) failure = error;
        else throw error;
      }
      if (failure?.status !== 401)
        throw new Error("Revoked browser application role retained new access");
      return {
        acknowledgedSubscriptionClosed: true,
        newRequestStatus: failure.status,
        normalBrowserTransport: true,
      };
    } finally {
      state.subscription.close();
      active = undefined;
    }
  },
  async denied(input) {
    try {
      await client(input).conversations.get(input.conversationId);
    } catch (error) {
      return {
        nativeBrowserRefusedUnallowlistedOrigin: true,
        clientErrorCode: error instanceof FortiPiError ? error.code : "native-fetch-failure",
        httpStatus: error instanceof FortiPiError ? (error.status ?? null) : null,
      };
    }
    throw new Error("An unallowlisted browser origin obtained private conversation state");
  },
};
Object.assign(globalThis, { fortipiEvidence: port });
