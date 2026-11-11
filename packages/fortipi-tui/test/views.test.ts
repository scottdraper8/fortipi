import assert from "node:assert/strict";
import { test } from "node:test";
import { Controller, runTerminal } from "fortipi-tui";
import { content, header, sanitize } from "../dist/views.js";
import { FixtureService } from "./fixtures/service.ts";
import { FixtureTerminal } from "./fixtures/terminal.ts";

void test("remote terminal controls and links are stripped; offline state remains distinct from task wait", async () => {
  assert.equal(
    sanitize(
      "safe\u001b]52;c;evil\u0007\u001b[2J\u001b]8;;https://evil\u001b\\link\u001b]8;;\u001b\\\u202e text",
    ),
    "safelink text",
  );
  const service = new FixtureService();
  await service.start();
  const controller = new Controller(service.client());
  try {
    await controller.open("conv_1");
    const snapshot = controller.projection.snapshot;
    assert(snapshot);
    snapshot.conversation.taskState = {
      state: "waiting",
      reason: "reconciliation",
      supportedContinuations: [],
    };
    controller.connection = "offline";
    const value = header(controller, "local", "composer");
    assert(value.includes("offline"));
    assert(value.includes("waiting: reconciliation"));
    controller.detail = "evil\u001b[31m detail";
    controller.view = "workspace";
    assert.equal(content(controller), "evil detail");
  } finally {
    controller.close();
    await service.close();
  }
});
void test("actual Pi renderer handles keyboard navigation, composer send, focus, disconnect and cleanup through shared controller", async () => {
  const service = new FixtureService();
  await service.start();
  const controller = new Controller(service.client());
  const terminal = new FixtureTerminal();
  try {
    const running = runTerminal(controller, {
      terminal,
      profileName: "fixture",
      noAnimation: true,
    });
    terminal.key("/agents\r");
    await wait(() => controller.choices.length === 1);
    terminal.key("\u001b[Z");
    terminal.key("\t");
    terminal.key("\r");
    await wait(() => controller.view === "conversations" && controller.choices[0]?.id === "conv_1");
    terminal.key("\r");
    await wait(() => controller.connection === "online");
    terminal.key("\u001b");
    terminal.key("typed from keyboard\r");
    await wait(
      () =>
        service.admissions.size === 1 &&
        controller.projection.tasks.get("task_1")?.status.state === "completed",
    );
    terminal.key("/disconnect\r");
    await wait(() => controller.connection === "offline");
    terminal.key("/reconnect\r");
    await wait(() => controller.connection === "online");
    terminal.key("/ids\r");
    await wait(() => controller.view === "ids");
    assert(terminal.output.includes("FortiPi"));
    assert(terminal.output.includes("fixture"));
    terminal.key("\u0003");
    await running;
    assert(terminal.stopped);
  } finally {
    controller.close();
    await service.close();
  }
});
async function wait(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("component state deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
