import type * as D from "../../../src/boundary/dto.js";
import { within } from "../../../src/control/store.js";
import { TestControlPlane as BaseControlPlane } from "./worker.js";

export { default, TestRecipient } from "./worker.js";

export class TestControlPlane extends BaseControlPlane {
  private entered: (() => void) | undefined;
  private exchangeGate: Promise<void> | undefined;
  protected override providerTransport(): typeof fetch {
    const transport = super.providerTransport();
    return async (input, init) => {
      this.entered?.();
      await this.exchangeGate;
      return transport(input, init);
    };
  }
  async cancelledRefresh(ctx: D.AuthContext, credential: D.OAuthCredential) {
    let release: () => void = () => undefined;
    this.exchangeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      this.entered = resolve;
    });
    const controller = new AbortController();
    const resolving = this.providerAuth.models
      .getAuth("openai", { signal: controller.signal })
      .then(
        () => undefined,
        () => undefined,
      );
    try {
      await within(entered);
      controller.abort();
      let ingestSettled = false;
      const ingest = this.putProviderAuth(ctx, {
        operationId: "putProviderAuth",
        path: { providerId: "openai" },
        query: {},
        body: { requestId: "cancelled-refresh-stale-ingest", expectedVersion: 1, credential },
      }).then((result) => {
        ingestSettled = true;
        return result;
      });
      // Allow queued management work to reach the real per-provider store chain.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const blockedWhileRefreshing = !ingestSettled;
      release();
      await resolving;
      const result = await ingest;
      return {
        blockedWhileRefreshing,
        staleRejected: !result.ok && result.code === "conflict",
        state: this.providerAuth.credentials.status("openai"),
      };
    } finally {
      release();
      this.entered = undefined;
      this.exchangeGate = undefined;
    }
  }
}
