import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TicketIdentity } from "fortipi-contract/executor";
import { hash } from "../../dist/policy.js";

/** Real HTTP byte transport, synthetic authority. This does not stand in for CP/workerd durability. */
export async function relayFixture(data: Buffer) {
  const requests: { path: string; authorization: string | undefined; bytes: Buffer }[] = [];
  let corrupt = false,
    pressure = false,
    redirect = false;
  let ticketIdentity: TicketIdentity | undefined;
  const server = createServer(async (req, res) => {
    const pieces: Buffer[] = [];
    for await (const piece of req) pieces.push(Buffer.from(piece as Buffer));
    const bytes = Buffer.concat(pieces);
    requests.push({ path: req.url ?? "", authorization: req.headers.authorization, bytes });
    if (req.url === "/v1/connections/tickets" && ticketIdentity) {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ticket: "T".repeat(64),
          audience: "executor-session",
          expiresAt: Date.now() + 30000,
          identity: ticketIdentity,
        }),
      );
      return;
    }
    if (redirect) {
      res.writeHead(302, { Location: "http://127.0.0.1:1/exfiltrate" });
      res.end();
      return;
    }
    if (pressure) {
      res.writeHead(503, { "Retry-After": "60" });
      res.end();
      return;
    }
    if (req.method === "GET") {
      const value = corrupt ? Buffer.from("bad") : data;
      res.writeHead(200, {
        "Content-Length": String(value.length),
        "X-Content-SHA256": hash(data),
      });
      res.end(value);
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    setCorrupt(value: boolean) {
      corrupt = value;
    },
    setTicketIdentity(value: TicketIdentity) {
      ticketIdentity = value;
    },
    setPressure(value: boolean) {
      pressure = value;
    },
    setRedirect(value: boolean) {
      redirect = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
