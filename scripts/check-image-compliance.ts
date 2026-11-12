// Fixed CI/local entrypoint for authenticated kit and actual image checks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sourceRevision } from "../apps/worker/container/recipient.ts";
import { repository } from "./build-workspaces.ts";
import {
  hashFile,
  verifyImageSourceDistribution,
  verifySourceKit,
} from "./image-source-distribution.ts";

assert.ok(
  process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--image"),
);
const directory = resolve(repository, "apps/worker/dist/container");
const kit = resolve(directory, "sources-and-notices.tar");
const kitSha256 = await hashFile(kit);
const revision = JSON.parse(await readFile(resolve(directory, "source-revision.json"), "utf8")) as {
  sourceCommit: string;
  recipeMatchesCommit: boolean;
};
assert.equal(revision.recipeMatchesCommit, true, "Committed integrated recipe required");
assert.equal(revision.sourceCommit, await sourceRevision());
if (process.env.GITHUB_ACTIONS === "true")
  assert.equal(revision.sourceCommit, process.env.SOURCE_SHA);
if (process.argv[2] === "--image") {
  const temporary = await mkdtemp(resolve(tmpdir(), "fortipi-image-consumer-"));
  try {
    const options = {
      kit,
      kitSha256,
      commit: revision.sourceCommit,
      image: resolve(directory, "image.tar"),
      metadata: resolve(directory, "image-metadata.json"),
      metadataSha256: await hashFile(resolve(directory, "image-metadata.json")),
      records: directory,
    };
    const received = await verifySourceKit(options, resolve(temporary, "kit"));
    const image = await verifyImageSourceDistribution(options, received);
    const result = {
      schemaVersion: 1,
      claim: "image-source-artifact",
      sourceCommit: revision.sourceCommit,
      sourceKitSha256: kitSha256,
      ...image,
      sourceVerified: true,
      replacementVerified: false,
      deliveryVerified: false,
      cloudVerified: false,
    };
    await writeFile(
      resolve(directory, "image-source-verification.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: "wx" },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else {
  const child = spawn(
    process.execPath,
    [
      "--test",
      "apps/worker/container/library-replacement.test.ts",
      "scripts/image-source-distribution.test.ts",
      "scripts/image-source-distribution.enforcer.test.ts",
    ],
    {
      cwd: repository,
      stdio: "inherit",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CI: "true",
        WRANGLER_SEND_METRICS: "false",
        FORTIPI_SOURCE_KIT: kit,
        FORTIPI_SOURCE_KIT_SHA256: kitSha256,
        FORTIPI_NATIVE_INPUTS: resolve(directory, "native-compatibility"),
      },
    },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), 180000);
  const code = await new Promise<number | null>((accept, reject) => {
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      accept(code);
    });
  });
  assert.equal(code, 0, "Image source compliance tests failed");
}
