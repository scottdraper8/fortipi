import assert from "node:assert/strict";
import {
  bindLocalImage,
  type NativeImageObservation,
  type PhysicalImageIdentity,
  type PhysicalImageObservation,
  verifyPhysicalImage,
} from "./local-image-binding.ts";

/** Controller only: every fresh harness must register its independently verified archive identity. */
export async function prepareLocalImageHarness(
  harness: {
    fetch(
      path: string,
      init?: { method: string; headers: Record<string, string>; body: string },
    ): Promise<{ status: number; json(): Promise<unknown> }>;
  },
  pins: { imageId: string; manifestDigest: string },
  docker: (args: string[]) => string | Promise<string>,
  verifyInputs: () => Promise<void>,
) {
  await verifyInputs();
  const prepared = await harness.fetch("/prepared-image");
  assert.equal(prepared.status, 200);
  const selected: unknown = await prepared.json();
  assert.ok(typeof selected === "string");
  const binding = bindLocalImage(
    { preparedReference: selected, ...pins },
    pins.imageId,
    pins.manifestDigest,
    selected,
  );
  assert.equal(
    (await docker(["image", "inspect", selected, "--format", "{{.Id}}"])).trim(),
    pins.imageId,
    "Wrangler's actual prepared runtime image differs from the verified image",
  );
  const packet = JSON.stringify({
    preparedReference: binding.preparedReference,
    imageId: binding.imageId,
    manifestDigest: binding.manifestDigest,
  });
  assert.equal(
    (
      await harness.fetch("/bind-local-image", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(packet)),
        },
        body: packet,
      })
    ).status,
    200,
    "Fresh, unstarted local harness must accept its verified binding",
  );
  assert.equal(
    (await harness.fetch("/prepare-linux?backend=linux")).status,
    200,
    "Actual native connection must precede physical-image proof and tool execution",
  );
  const inspectPhysical = async (prior?: PhysicalImageIdentity) => {
    await verifyInputs();
    assert.equal(
      (await docker(["image", "inspect", selected, "--format", "{{.Id}}"])).trim(),
      pins.imageId,
      "Wrangler prepared tag changed its verified config binding",
    );
    const observation = await harness.fetch("/native-image");
    assert.equal(observation.status, 200);
    const native = (await observation.json()) as NativeImageObservation;
    const ids = (await docker(["ps", "--quiet", "--no-trunc"])).trim().split("\n");
    assert.ok(ids.length > 0 && ids.length <= 8 && ids.every((id) => /^[a-f0-9]{64}$/.test(id)));
    const format =
      '{"id":{{json .Id}},"imageId":{{json .Image}},"reference":{{json .Config.Image}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}}}';
    const containers = (await docker(["inspect", "--format", format, ...ids]))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as PhysicalImageObservation);
    const matching = containers.filter((row) => row.reference === selected);
    assert.equal(
      matching.length,
      1,
      "Exactly one actual selected application container is required",
    );
    const actual = matching[0];
    assert.ok(actual);
    return verifyPhysicalImage(binding, native, actual, prior);
  };
  return { binding, inspectPhysical };
}
