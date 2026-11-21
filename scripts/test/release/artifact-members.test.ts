import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { type ArtifactReference, githubRequest, sha256 } from "../../verify-release-gates.ts";
import { directoryArchive, httpFixture, temporary } from "./fixtures.ts";

test("finite artifact transport authenticates one real ZIP and refuses namespace, byte and digest faults", async () => {
  const directory = await temporary("fortipi-finite-artifact-");
  const first = Buffer.from('{"phase":"a"}\n');
  const second = Buffer.from("opaque bounded bytes");
  let archive: Awaited<ReturnType<typeof directoryArchive>> | undefined;
  let requests = 0;
  const server = await httpFixture((request, response) => {
    requests++;
    assert.equal(request.url, "/repos/scottdraper8/fortipi/actions/artifacts/23/zip");
    assert.equal(request.headers.authorization, "Bearer synthetic-test-token");
    assert.ok(archive);
    response.end(archive.bytes);
  });
  try {
    await writeFile(resolve(directory, "device-phase.json"), first);
    await writeFile(resolve(directory, "device-a.json"), second);
    archive = await directoryArchive(directory);
    const reference: ArtifactReference = {
      runId: 1,
      runAttempt: 1,
      artifactId: 23,
      artifactName: "synthetic-transport-only",
      artifactDigest: `sha256:${sha256(archive.bytes)}`,
      candidateSha256: sha256("synthetic-candidate"),
    };
    const request = githubRequest("synthetic-test-token", server.transport);
    const bounds = { "device-phase.json": first.length, "device-a.json": second.length };
    const read = () => request.verifyArtifactMembers(reference, bounds);
    const actual = await read();
    assert.equal(requests, 1, "All selected members come from one authenticated download");
    assert.deepEqual([...actual.names].sort(), Object.keys(bounds).sort());
    assert.deepEqual(actual.members["device-phase.json"], first);
    assert.deepEqual(actual.members["device-a.json"], second);

    await assert.rejects(request.verifyArtifactMembers(reference, { "device-phase.json": 64 }));
    await assert.rejects(
      request.verifyArtifactMembers(reference, { ...bounds, "device-a.json": 1 }),
    );
    await assert.rejects(
      request.verifyArtifactMembers(
        { ...reference, artifactDigest: `sha256:${"0".repeat(64)}` },
        bounds,
      ),
      /archive digest mismatch/,
    );
    const before = requests;
    await assert.rejects(request.verifyArtifactMembers(reference, { "../escape": 1 }));
    await assert.rejects(
      request.verifyArtifactMembers(reference, { "device-phase.json": 8_000_001 }),
    );
    let getterCalls = 0;
    await assert.rejects(
      request.verifyArtifactMembers(
        reference,
        Object.defineProperty({}, "device-phase.json", {
          enumerable: true,
          get() {
            getterCalls++;
            return 64;
          },
        }),
      ),
    );
    assert.equal(getterCalls, 0);
    assert.equal(requests, before, "Invalid caller bounds reject before transport");

    await archive.close();
    await writeFile(resolve(directory, "unexpected.json"), "{}");
    archive = await directoryArchive(directory);
    reference.artifactDigest = `sha256:${sha256(archive.bytes)}`;
    await assert.rejects(read(), "Even a digest-authenticated extra member is refused");
    await archive.close();
    await rm(resolve(directory, "unexpected.json"));
    // Enforce the response byte bound before ZIP parsing, even for an authenticated digest.
    const bytes = Buffer.alloc(100_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
    archive.bytes = bytes;
    reference.artifactDigest = `sha256:${sha256(bytes)}`;
    await assert.rejects(read(), /Artifact download byte bound/);
  } finally {
    await server.close();
    await archive?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
