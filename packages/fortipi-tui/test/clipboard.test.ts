import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyText } from "../dist/clipboard.js";

void test("compiled clipboard helper is retained, bounded, killable and receives no application credential environment", async () => {
  await access(new URL("../dist/clipboard-helper.js", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "fortipi-clipboard-"));
  try {
    const helper = join(directory, "helper.ts");
    await writeFile(
      helper,
      "for await (const chunk of process.stdin) { if (String(chunk) !== 'copyable id') process.exitCode = 1; } if (process.env.FORTIPI_TEST_SECRET) process.exitCode = 1;",
    );
    process.env.FORTIPI_TEST_SECRET = "synthetic";
    assert.equal((await copyText("copyable id", helper)).ok, true);
    delete process.env.FORTIPI_TEST_SECRET;
    await writeFile(helper, "setInterval(() => {}, 1000);");
    const started = Date.now();
    const result = await copyText("id", helper);
    assert.equal(result.ok, false);
    assert(result.message.includes("select"));
    assert(Date.now() - started < 1500);
    assert.equal((await copyText("a".repeat(65537), helper)).ok, false);
  } finally {
    delete process.env.FORTIPI_TEST_SECRET;
    await rm(directory, { recursive: true, force: true });
  }
});
