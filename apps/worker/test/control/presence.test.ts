import assert from "node:assert/strict";
import test from "node:test";
import { connected } from "./connection.ts";
import { harness, uuid } from "./harness.ts";

test("actual heartbeat keeps a recovered executor channel fresh beyond registration expiry without SQL writes", async () => {
  const h = await harness();
  let socket: WebSocket | undefined;
  try {
    const channel = await connected(h);
    socket = channel.socket;
    const registeredAt = Date.now();
    for (let pulse = 0; pulse < 3; pulse++) {
      await new Promise((resolve) => setTimeout(resolve, 15050));
      const requestId = uuid();
      const before = await h.cp.rowCount("inbox");
      channel.send({
        type: "executor.heartbeat",
        requestId,
        payload: {
          executorId: "executor",
          generation: 1,
          connectionEpoch: channel.epoch,
          timestamp: Date.now(),
        },
      });
      await channel.wait("executor.heartbeat", (frame) => frame.requestId === requestId);
      assert.equal(
        await h.cp.rowCount("inbox"),
        before,
        "heartbeat cannot create a durable inbox delivery",
      );
    }
    assert.ok(Date.now() - registeredAt >= 45000, "exercise the unchanged actual freshness bound");
    const recovered = await h.cp.recoveredPresence("executor", 1);
    assert.equal(
      recovered.ok,
      true,
      "actual recent heartbeats must keep the channel fresh after volatile liveness is lost",
    );
    if (recovered.ok) assert.equal(recovered.value, true);
  } finally {
    socket?.close();
    await h.close();
  }
});
