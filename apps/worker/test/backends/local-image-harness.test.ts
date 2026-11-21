import assert from "node:assert/strict";
import test from "node:test";
import { prepareLocalImageHarness } from "./local-image-harness.ts";

// Controller protocol controls only; these observations substitute for Docker/native storage.
// Actual mounted execution and library-replacement proof require the Linux image job.
function fixture(image: string, manifest: string, suffix: string) {
  const pins = {
    imageId: `sha256:${image.repeat(64)}`,
    manifestDigest: `sha256:${manifest.repeat(64)}`,
  };
  const reference = `cloudflare-dev/probehost-computerd-8d30bbdf7d69:${suffix.repeat(8)}`;
  const events: string[] = [];
  let registered = false;
  let started = false;
  const physical = {
    id: "d".repeat(64),
    imageId: pins.imageId,
    reference,
    running: true,
    startedAt: "2026-11-12T12:00:00.000Z",
  };
  const harness: Parameters<typeof prepareLocalImageHarness>[0] = {
    async fetch(path, init) {
      events.push(path);
      switch (path) {
        case "/prepared-image":
          return Response.json(reference);
        case "/bind-local-image":
          assert.equal(started, false, "Cannot bind an existing runtime");
          assert.equal(registered, false, "Cannot rebind a session");
          assert.equal(init?.method, "POST");
          assert.ok(init?.body);
          assert.equal(init.headers["content-length"], String(Buffer.byteLength(init.body)));
          assert.deepEqual(JSON.parse(init.body), { preparedReference: reference, ...pins });
          registered = true;
          return new Response(null);
        case "/prepare-linux?backend=linux":
          assert.equal(registered, true, "Fresh runtime must first receive its own binding");
          started = true;
          return new Response(null);
        case "/native-image":
          assert.equal(started, true);
          return Response.json({ image: reference, labels: { fortipi_owner: "e".repeat(64) } });
        default:
          throw new Error(`Unexpected controller request: ${path}`);
      }
    },
  };
  const docker = (args: string[]) => {
    events.push(args[0] ?? "");
    if (args[0] === "image") {
      assert.deepEqual(args, ["image", "inspect", reference, "--format", "{{.Id}}"]);
      return physical.imageId;
    }
    if (args[0] === "ps") return physical.id;
    assert.equal(args[0], "inspect");
    assert.equal(args.at(-1), physical.id);
    return JSON.stringify(physical);
  };
  const verify = async () => {
    events.push("verified-inputs");
  };
  return { pins, harness, docker, verify, events, physical };
}

test("each fresh controller session registers its own selected config/manifest before native startup", async () => {
  const baseline = fixture("a", "b", "0");
  const modified = fixture("c", "f", "1");
  for (const probe of [baseline, modified]) {
    const prepared = await prepareLocalImageHarness(
      probe.harness,
      probe.pins,
      probe.docker,
      probe.verify,
    );
    assert.equal(prepared.binding.manifestDigest, probe.pins.manifestDigest);
    assert.deepEqual(probe.events, [
      "verified-inputs",
      "/prepared-image",
      "image",
      "/bind-local-image",
      "/prepare-linux?backend=linux",
    ]);
    const before = await prepared.inspectPhysical();
    assert.deepEqual(await prepared.inspectPhysical(before), before);
    probe.physical.startedAt = "2026-11-12T12:01:00.000Z";
    await assert.rejects(prepared.inspectPhysical(before), /changed during execution/);
  }
});

test("wrong selected image stops before registration; a running session cannot be rebound", async () => {
  const probe = fixture("a", "b", "0");
  probe.physical.imageId = `sha256:${"c".repeat(64)}`;
  await assert.rejects(
    prepareLocalImageHarness(probe.harness, probe.pins, probe.docker, probe.verify),
    /prepared runtime image differs/,
  );
  assert.deepEqual(probe.events, ["verified-inputs", "/prepared-image", "image"]);
  probe.physical.imageId = probe.pins.imageId;
  await prepareLocalImageHarness(probe.harness, probe.pins, probe.docker, probe.verify);
  await assert.rejects(
    prepareLocalImageHarness(probe.harness, probe.pins, probe.docker, probe.verify),
    /Cannot bind an existing runtime/,
  );
});
