// Executes one synthetic registry effect, never pnpm/npm or a real publication.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [origin, journalPath, archivePath, name] = process.argv.slice(2);
assert.ok(origin && journalPath && archivePath && name && origin.startsWith("http://127.0.0.1:"));
assert.deepEqual(JSON.parse(String(process.env.pnpm_config__auth)), {
  "https://registry.npmjs.org": { "@": { authToken: "synthetic-publication-role" } },
});
for (const key of ["FORTIPI_ADMIN_TOKEN", "CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"])
  assert.equal(process.env[key], undefined);
const journal = JSON.parse(await readFile(journalPath, "utf8"));
assert.equal(
  journal.packages.find((p: { name: string }) => p.name === name).state,
  "upload-intent",
);
const response = await fetch(`${origin}/upload`, {
  method: "PUT",
  body: await readFile(archivePath),
  redirect: "error",
});
assert.equal(response.status, 202);
console.log(JSON.stringify({ error: { code: "ERR_PNPM_PUBLISH_AVAILABILITY_TIMEOUT" } }));
process.exitCode = 1;
