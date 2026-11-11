import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { AdminClient } from "../dist/admin.js";
import { readConfig } from "../dist/config.js";
import { protectDirectory } from "../dist/profiles.js";

export const example = new URL("../templates/operator-config.example.json", import.meta.url);
export async function config() {
  return readConfig(example.pathname);
}
export async function temp(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), "fortipi-cli-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const data = join(path, "data");
  await protectDirectory(data);
  return data;
}
export async function server(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  t.after(() => {
    instance.closeAllConnections();
    instance.close();
  });
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("test listener missing");
  const endpoint = `http://127.0.0.1:${address.port}`;
  return {
    endpoint,
    api: new AdminClient(
      { version: 1, endpoint, role: "admin", token: "synthetic-admin" },
      { allowLoopback: true, timeoutMs: 1000 },
    ),
  };
}
export function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
