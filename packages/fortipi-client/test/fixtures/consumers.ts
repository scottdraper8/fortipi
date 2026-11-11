import type { FortiPiClient as BrowserClient } from "fortipi-client/browser";
import type { FortiPiClient as NodeClient } from "fortipi-client/node";
import type { OperationRequest } from "fortipi-contract/client";
export function consumers(browser: BrowserClient, native: NodeClient) {
  const send: OperationRequest<"submitMessage"> = {
    operationId: "submitMessage",
    path: { id: "conv" },
    query: {},
    body: { clientRequestId: "intent", content: "hello", busyBehavior: "reject" },
  };
  void browser.request(send);
  void native.operations.submitMessage({ path: { id: "conv" }, query: {}, body: send.body });
  void browser.operations.submitMessage({
    path: { id: "conv" },
    query: {},
    // @ts-expect-error operation body must retain canonical busy behavior
    body: { content: "hello" },
  });
  // @ts-expect-error public commit has opaque stage, never a private allocation
  void native.uploads.commit("ws", "up", { childId: "private" });
}
