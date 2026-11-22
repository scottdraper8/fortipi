import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { preservePlatformMetadata } from "./review-platforms.ts";

test("platform revalidation preserves independent evidence and refuses changed facts", async () => {
  const original = await readFile(new URL("./platform-tools.json", import.meta.url), "utf8");
  const catalog = JSON.parse(original);
  const reviewed = structuredClone({
    format: catalog.format,
    actions: catalog.actions,
    images: catalog.images,
    docker: catalog.docker,
    fuse: catalog.fuse,
  });
  const oldReview = { checkedAt: "2025-01-02T03:04:05.000Z", finding: "retained limitation" };
  // Include unknown future records and nested owner evidence as well as the actual catalog.
  catalog.dockerRootless = { securityReview: oldReview };
  catalog.rootlessVerification = { source: "independent fixture", reviewedAt: oldReview.checkedAt };
  catalog.futurePlatform = { unresolved: ["runtime qualification"], review: oldReview };
  catalog.actions[0].securityReview = oldReview;
  catalog.images[0].sourceReview = oldReview;
  catalog.docker.securityReview = oldReview;
  const expected = structuredClone(catalog);
  const facts = structuredClone(reviewed);

  assert.deepEqual(preservePlatformMetadata(catalog, reviewed), expected);
  assert.deepEqual(catalog, expected, "revalidation must not mutate any previous source record");
  assert.deepEqual(reviewed, facts, "observations must not acquire unreviewed source records");

  for (const change of [
    () => {
      reviewed.docker.sha256 = "0".repeat(64);
    },
    () => {
      reviewed.docker.version = "0.0.0";
    },
    () => {
      reviewed.actions[0].sha = "0".repeat(40);
    },
    () => {
      reviewed.images[0].digest = `sha256:${"0".repeat(64)}`;
    },
    () => {
      reviewed.fuse.fuse3 = "0.0.0";
    },
    () => {
      reviewed.actions.pop();
    },
  ]) {
    Object.assign(reviewed, structuredClone(facts));
    change();
    assert.throws(() => preservePlatformMetadata(catalog, reviewed), /scoped review required/);
  }
  assert.throws(() => preservePlatformMetadata({}, facts), /Unsupported platform metadata format/);
  assert.throws(
    () => preservePlatformMetadata({ ...catalog, reviewedAt: undefined }, facts),
    /Missing original platform review timestamp/,
  );
  assert.throws(
    () => preservePlatformMetadata({ ...catalog, docker: {} }, facts),
    /missing reviewed platform fact/,
  );
  assert.deepEqual(catalog, expected, "refusal must not modify independently reviewed evidence");
  assert.equal(await readFile(new URL("./platform-tools.json", import.meta.url), "utf8"), original);
});
