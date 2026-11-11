import assert from "node:assert/strict";

// Runner consumes authorized masked inputs only. It never creates resources or deploys.
const endpoint = process.env.FORTIPI_LINUX_PROBE_ENDPOINT;
const token = process.env.FORTIPI_LINUX_PROBE_TOKEN;
assert.ok(endpoint && token, "Authorized endpoint and scoped probe credential are required");
const url = new URL(endpoint);
assert.equal(url.protocol, "https:");
const response = await fetch(url, {
  method: "POST",
  redirect: "error",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ requestId: crypto.randomUUID(), requireFuse: true }),
  signal: AbortSignal.timeout(60_000),
});
assert.equal(response.status, 200, "Authorized Linux runtime fixture failed");
const proof = (await response.json()) as {
  status: string;
  exitCode: number;
  content: string;
  canary: boolean;
  sync: string;
  skipped: number;
  fuse: boolean;
};
assert.equal(proof.status, "completed");
assert.equal(proof.exitCode, 0);
assert.equal(proof.content, "fortipi-result");
assert.equal(proof.canary, true);
assert.equal(proof.sync, "complete");
assert.equal(proof.skipped, 0);
assert.equal(proof.fuse, true);
process.stdout.write(
  "Authorized Linux execution, scratch round trip and real FUSE mount observed\n",
);
