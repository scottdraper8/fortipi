import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { createServer } from "node:https";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import type { Installed } from "../distribution/install.ts";
import type { BrowserInput, BrowserPort } from "./browser-entry.ts";
import { type FixtureTLS, fixtureTLS, verifyFixtureTLS } from "./fixture-tls.ts";

export const liveBrowserPort = 10110;

type BrowserInstalled = Pick<Installed, "resolveExport" | "consumer"> & {
  candidate: { scope: string };
};
export async function browser(
  installed: BrowserInstalled,
  options: { port?: number; tls?: FixtureTLS } = {},
) {
  return browserGraph(
    {
      clientEntry: installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/browser`),
      productRoots: [resolve(installed.consumer, "node_modules")],
      installed: true,
    },
    options,
  );
}
/** Source-only engineering port, never an installed/candidate substitute. */
export async function sourceBrowser() {
  const root = resolve(import.meta.dirname, "../..");
  return browserGraph(
    {
      clientEntry: resolve(root, "packages/fortipi-client/dist/browser.js"),
      productRoots: [
        resolve(root, "packages/fortipi-client"),
        resolve(root, "packages/fortipi-contract"),
        resolve(root, "node_modules"),
      ],
      installed: false,
    },
    {},
  );
}
async function browserGraph(
  graph: { clientEntry: string; productRoots: string[]; installed: boolean },
  options: { port?: number; tls?: FixtureTLS },
) {
  const entry = resolve(import.meta.dirname, "browser-entry.ts");
  const shared = resolve(import.meta.dirname, "public-flow.ts");
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2024",
    metafile: true,
    plugins: [
      {
        name: "installed-browser-only",
        setup(builder) {
          builder.onResolve({ filter: /fortipi-client\/dist\/browser\.js$/ }, () => ({
            path: graph.clientEntry,
          }));
          builder.onResolve({ filter: /.*/ }, (args) => {
            assert.ok(
              !args.path.startsWith("node:") && !builtinModules.includes(args.path),
              "Installed browser graph contains a Node dependency",
            );
            return undefined;
          });
        },
      },
    ],
    logLevel: "silent",
  });
  for (const name of Object.keys(bundle.metafile.inputs)) {
    const path = resolve(name);
    assert.ok(
      path === entry ||
        path === shared ||
        graph.productRoots.some((root) => path.startsWith(`${root}${sep}`)),
      "Browser graph escaped its explicitly selected product/dependency roots",
    );
  }
  const js = bundle.outputFiles[0]?.contents;
  assert.ok(js);
  const serve: RequestListener = (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/client.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(js);
    } else if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        '<!doctype html><title>FortiPi evidence</title><script type="module" src="/client.js"></script>',
      );
    } else {
      response.writeHead(404);
      response.end();
    }
  };
  const tls = options.tls ?? (await fixtureTLS());
  const identity = await verifyFixtureTLS(tls);
  assert.equal(identity.leafSpki, tls.leafSpki);
  const certificate = { key: await readFile(tls.key), cert: await readFile(tls.cert) };
  const server = createServer(certificate, serve),
    forbidden = createServer(certificate, serve);
  if (options.port !== undefined)
    assert.ok(Number.isSafeInteger(options.port) && options.port >= 1024 && options.port <= 65535);
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", accept);
  });
  try {
    await new Promise<void>((accept, reject) => {
      forbidden.once("error", reject);
      forbidden.listen(0, "127.0.0.1", accept);
    });
  } catch (error) {
    await new Promise<void>((accept) => server.close(() => accept()));
    throw error;
  }
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://127.0.0.1:${address.port}`;
  const other = forbidden.address();
  assert.ok(other && typeof other !== "string");
  const forbiddenOrigin = `https://127.0.0.1:${other.port}`;
  const engines = new Set<Awaited<ReturnType<typeof chromium.launchPersistentContext>>>();
  let closing: Promise<void> | undefined;
  return {
    origin,
    tls,
    async run(
      input: BrowserInput,
      revoke?: () => Promise<void>,
      observe: (stage: string) => void = () => {},
    ) {
      observe("chromium-launch");
      const home = await mkdtemp(resolve(tmpdir(), "fortipi-evidence-chromium-"));
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        LANG: "C.UTF-8",
        XDG_CONFIG_HOME: resolve(home, "config"),
        XDG_CACHE_HOME: resolve(home, "cache"),
      };
      if (process.platform === "win32") {
        assert.ok(process.env.SystemRoot);
        env.SystemRoot = process.env.SystemRoot;
        env.APPDATA = resolve(home, "roaming");
        env.LOCALAPPDATA = resolve(home, "local");
      }
      let engine: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
      try {
        engine = await chromium.launchPersistentContext(resolve(home, "profile"), {
          env,
          ignoreHTTPSErrors: false,
          args: [`--ignore-certificate-errors-spki-list=${tls.leafSpki}`],
        });
        engines.add(engine);
      } catch (error) {
        await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        throw error;
      }
      let sockets = 0;
      try {
        const page = await engine.newPage();
        const network = await engine.newCDPSession(page);
        const preflights = new Set<string>(),
          acceptedPreflights: { method: "OPTIONS"; status: number; exactAllowedOrigin: boolean }[] =
            [];
        await network.send("Network.enable");
        // Extract only method/status and the public allow-origin equality. Never
        // retain request/response objects, auth headers, ticket URLs or traces.
        network.on(
          "Network.requestWillBeSent",
          (event: { requestId: string; request: { method: string } }) => {
            if (event.request.method === "OPTIONS") preflights.add(event.requestId);
          },
        );
        network.on(
          "Network.responseReceived",
          (event: {
            requestId: string;
            response: { status: number; headers: Record<string, string> };
          }) => {
            if (!preflights.has(event.requestId)) return;
            const allowed = Object.entries(event.response.headers).find(
              ([name]) => name.toLowerCase() === "access-control-allow-origin",
            )?.[1];
            acceptedPreflights.push({
              method: "OPTIONS",
              status: event.response.status,
              exactAllowedOrigin: allowed === origin,
            });
          },
        );
        // Do not inspect URLs, headers, frames or trace bodies; ticket values stay private.
        page.on("websocket", () => {
          sockets++;
        });
        observe("allowed-https-navigation");
        await page.goto(origin);
        await page.waitForFunction(() => "fortipiEvidence" in globalThis);
        observe("public-flow");
        let observation: Record<string, unknown>;
        try {
          observation = await page.evaluate(async (value) => {
            const runner = (globalThis as unknown as { fortipiEvidence: BrowserPort })
              .fortipiEvidence;
            return runner.run(value);
          }, input);
        } catch (error) {
          const diagnostic = await page.evaluate(() =>
            (
              globalThis as unknown as { fortipiEvidence: BrowserPort }
            ).fortipiEvidence.diagnostic(),
          );
          throw Object.assign(new Error("Browser public flow failed"), {
            name: error instanceof Error ? error.name : "UnknownFailure",
            diagnostic,
          });
        }
        observe("actual-preflight");
        assert.ok(
          acceptedPreflights.length > 0 &&
            acceptedPreflights.every(
              (item) => [200, 204].includes(item.status) && item.exactAllowedOrigin,
            ),
          "Native browser must complete actual allowlisted preflights",
        );
        assert.ok(sockets >= 2, "Native browser ticket WebSockets must actually open");
        observe("unallowlisted-https-navigation");
        const otherPage = await engine.newPage();
        await otherPage.goto(forbiddenOrigin);
        await otherPage.waitForFunction(() => "fortipiEvidence" in globalThis);
        // Observe only Chromium's CORS disposition. No URLs, headers, request
        // bodies, frames or credentials are inspected or retained.
        const diagnostic = await engine.newCDPSession(otherPage);
        const corsErrors: string[] = [];
        await diagnostic.send("Network.enable");
        diagnostic.on(
          "Network.loadingFailed",
          (event: { corsErrorStatus?: { corsError: string } }) => {
            if (event.corsErrorStatus) corsErrors.push(event.corsErrorStatus.corsError);
          },
        );
        observe("browser-cors-denial");
        const cors = await otherPage.evaluate(
          (value) =>
            (globalThis as unknown as { fortipiEvidence: BrowserPort }).fortipiEvidence.denied(
              value,
            ),
          input,
        );
        const corsDeadline = Date.now() + 3000;
        while (!corsErrors.length && Date.now() < corsDeadline)
          await new Promise<void>((accept) => setTimeout(accept, 25));
        assert.ok(
          corsErrors.length > 0,
          "Unallowlisted-origin failure must be an actual browser CORS disposition",
        );
        await diagnostic.detach();
        await otherPage.close();
        let revocation: Record<string, unknown> | undefined;
        if (revoke) {
          observe("acknowledged-browser-revocation");
          await page.evaluate(
            (value) =>
              (globalThis as unknown as { fortipiEvidence: BrowserPort }).fortipiEvidence.arm(
                value,
              ),
            input,
          );
          await revoke();
          revocation = await page.evaluate(() =>
            (globalThis as unknown as { fortipiEvidence: BrowserPort }).fortipiEvidence.revoked(),
          );
        }
        await network.detach();
        return {
          ...observation,
          actualChromium: engine.browser()!.version(),
          nativeWebSockets: sockets,
          cors: { ...cors, browserCorsErrors: corsErrors },
          revocation: revocation ?? { unavailable: true },
          preflights: {
            observed: acceptedPreflights.length,
            methods: ["OPTIONS"],
            statuses: [...new Set(acceptedPreflights.map((item) => item.status))],
            allExactAllowedOrigin: true,
          },
          localTls: {
            ...identity,
            disposableCa: true,
            exactLeafSpkiException: true,
            publicCaHostnameRevocationValidationProved: false,
            openssl: tls.openssl,
          },
          installedBrowserGraph: graph.installed,
          sourceBrowserGraph: !graph.installed,
          nativeFetch: true,
          crossOrigin: new URL(input.endpoint).origin !== origin,
          noHeaderWorkaround: true,
        };
      } finally {
        engines.delete(engine);
        await engine.close();
        await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    close() {
      closing ??= (async () => {
        await Promise.all([...engines].map((engine) => engine.close()));
        server.closeAllConnections();
        forbidden.closeAllConnections();
        await Promise.all(
          [server, forbidden].map(
            (item) =>
              new Promise<void>((accept, reject) =>
                item.close((error) => (error ? reject(error) : accept())),
              ),
          ),
        );
        if (!options.tls)
          await rm(tls.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      })();
      return closing;
    },
  };
}
