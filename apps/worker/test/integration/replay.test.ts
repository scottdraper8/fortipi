import test from "node:test";
import { FortiPiClient } from "../../../../packages/fortipi-client/dist/node.js";
import { publicFlow } from "../../../../tests/clients/public-flow.ts";
import { provision } from "./fixture-state.ts";
import { start } from "./runtime.ts";

test("real TCP public clients apply task-correlated completion and exact original offline event envelopes", {
  timeout: 60000,
}, async () => {
  const runtime = await start();
  try {
    const state = await provision(runtime);
    const options = {
      endpoint: runtime.endpoint,
      allowLoopbackHttp: true,
      credentials: async () => state.client.token,
    };
    await publicFlow(new FortiPiClient(options), new FortiPiClient(options), {
      agentId: state.agent.agentId,
      conversationId: state.conversations[0]!.conversationId,
      seed: 1010,
    });
  } finally {
    await runtime.dispose();
  }
});
