// Observes the real app network namespace with the existing host Node client.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { Resolver, resolve4 } from "node:dns/promises";
import { lstat, readFile, readlink } from "node:fs/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { delimiter, dirname, resolve } from "node:path";
import { rootCertificates, TLSSocket } from "node:tls";
import { promisify } from "node:util";
import { repository } from "../../scripts/build-workspaces.ts";
import { hash } from "./review-supply-chain.ts";
import { isStepSecuritySinkhole } from "./verify-container-egress.ts";

const execute = promisify(execFile);
const self = resolve(repository, "tools/unstale/verify-app-network.ts");
const client = "host Node client in actual application network namespace";
const sidecarImage =
  "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8";
const format =
  '{"id":{{json .Id}},"image":{{json .Image}},"pid":{{.State.Pid}},"running":{{.State.Running}},"network":{{json .HostConfig.NetworkMode}},"imageRef":{{json .Config.Image}}}';
const env = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  DOCKER_HOST: process.env.DOCKER_HOST,
  DOCKER_CONFIG: process.env.DOCKER_CONFIG,
};
interface Container {
  id: string;
  image: string;
  pid: number;
  running: boolean;
  network: string;
  imageRef: string;
}
interface Authority {
  app: Container;
  sidecar: Container;
}
export interface ApplicationNetworkEvidence {
  imageId: string;
  appPid: number;
  authorityVerifiedBeforeAfter: boolean;
  allowedBefore: number | null;
  deniedStatus: number | null;
  deniedTransportFailure: boolean;
  allowedAfter: number | null;
  tlsAuthorized: boolean;
  syntheticDns: boolean;
  upstreamStepSecurityBeforeAfter: boolean;
}

type FetchRole = "allowed-before" | "denied-example" | "allowed-after";
type FetchEvent =
  | { role: FetchRole; phase: "START" }
  | { role: FetchRole; phase: "RESPONSE"; status: number }
  | { role: FetchRole; phase: "FAILURE"; causeCode: string; stepSecurityEndpoint: boolean };

/** Only a flat, wholly validated connect-refusal cause can identify the policy endpoint. */
function connectFailure(error: unknown): { causeCode: string; stepSecurityEndpoint: boolean } {
  const unknown = { causeCode: "UNKNOWN", stepSecurityEndpoint: false };
  try {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    )
      return { causeCode: "ABORT_ERR", stepSecurityEndpoint: false };
    const cause =
      typeof error === "object" && error !== null && "cause" in error ? error.cause : error;
    if (typeof cause !== "object" || cause === null) return unknown;
    const code = "code" in cause ? cause.code : undefined;
    const causeCode =
      typeof code === "string" &&
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "ENOTFOUND",
        "EAI_AGAIN",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
        "ABORT_ERR",
      ].includes(code)
        ? code
        : "UNKNOWN";
    const failures = cause instanceof AggregateError ? cause.errors : [cause];
    // Snapshot one numeric bound; never invoke methods supplied on the error's array.
    const count: unknown = Array.isArray(failures) ? failures.length : undefined;
    let stepSecurityEndpoint = false;
    if (
      causeCode === "ECONNREFUSED" &&
      typeof count === "number" &&
      count >= 1 &&
      count <= 4 &&
      Number.isInteger(count)
    ) {
      stepSecurityEndpoint = true;
      for (let index = 0; index < count; index++) {
        const failure: unknown = failures[index];
        if (
          typeof failure !== "object" ||
          failure === null ||
          failure instanceof AggregateError ||
          "errors" in failure ||
          !("code" in failure) ||
          failure.code !== "ECONNREFUSED" ||
          !("syscall" in failure) ||
          failure.syscall !== "connect" ||
          !("port" in failure) ||
          failure.port !== 443 ||
          !("address" in failure) ||
          typeof failure.address !== "string" ||
          !isStepSecuritySinkhole([failure.address])
        ) {
          stepSecurityEndpoint = false;
          break;
        }
      }
    }
    return { causeCode, stepSecurityEndpoint };
  } catch {
    return unknown;
  }
}

/** Observe the pinned harness's existing Node fetch without changing its promises or I/O. */
export function observeHarnessFetch() {
  const original = globalThis.fetch;
  const roles: FetchRole[] = ["allowed-before", "denied-example", "allowed-after"];
  const registry = "https://registry.npmjs.org/pnpm/12.18.0";
  const example = "https://example.com/";
  const events: FetchEvent[] = [];
  let calls = 0;
  let valid = true;
  let active = true;
  const record = (event: FetchEvent) => {
    if (active && events.length < 6) events.push(event);
    else valid = false;
  };
  const failure = (role: FetchRole, error: unknown) => {
    record({ role, phase: "FAILURE", ...connectFailure(error) });
  };
  const wrapper: typeof globalThis.fetch = function (this: unknown, ...args) {
    let role: FetchRole | undefined;
    try {
      const [input, init] = args;
      if (
        active &&
        typeof input === "string" &&
        [registry, example].includes(input) &&
        init?.method === "HEAD"
      ) {
        const ordinal = calls++;
        role = roles[ordinal];
        if (!role || input !== (ordinal === 1 ? example : registry)) valid = false;
        if (role) record({ role, phase: "START" });
      }
    } catch {
      valid = false;
    }
    let promise: ReturnType<typeof globalThis.fetch>;
    try {
      promise = Reflect.apply(original, this, args);
    } catch (error) {
      if (role) failure(role, error);
      throw error;
    }
    if (role) {
      const observedRole = role;
      try {
        void promise.then(
          (response) => {
            try {
              if (
                Number.isInteger(response.status) &&
                response.status >= 100 &&
                response.status <= 599
              )
                record({ role: observedRole, phase: "RESPONSE", status: response.status });
              else valid = false;
            } catch {
              valid = false;
            }
          },
          (error: unknown) => {
            failure(observedRole, error);
          },
        );
      } catch {
        valid = false;
      }
    }
    return promise;
  };
  globalThis.fetch = wrapper;
  return {
    stop() {
      if (active) {
        if (globalThis.fetch === wrapper) globalThis.fetch = original;
        else valid = false;
        active = false;
      }
      return {
        probe: "harness-node-fetch" as const,
        complete:
          valid &&
          calls === 3 &&
          events.length === 6 &&
          events.every(
            (event, index) =>
              event.role === roles[Math.floor(index / 2)] &&
              (index % 2 === 0 ? event.phase === "START" : event.phase !== "START"),
          ),
        events: events.map((event) => ({ ...event })),
      };
    },
  };
}

/** Gateway failure is meaningful only with the actual client and protected final-hop route. */
export function verifyGatewayEgress(
  messages: readonly { message: string }[],
  evidence: ApplicationNetworkEvidence,
  trace?: ReturnType<ReturnType<typeof observeHarnessFetch>["stop"]> & { namespaceStable: boolean },
): void {
  const events = messages
    .filter(({ message }) => message.startsWith("fortipi-gateway:"))
    .map(({ message }) => {
      assert.ok(message.length <= 256, "Gateway evidence exceeds its bound");
      let value: unknown;
      try {
        value = JSON.parse(message.slice("fortipi-gateway:".length));
      } catch {
        throw new Error("Malformed gateway evidence");
      }
      assert.ok(value && typeof value === "object", "Invalid gateway evidence");
      const event = value as Record<string, unknown>;
      assert.ok(
        Object.keys(event).length === 4 &&
          Object.keys(event).every((key) =>
            ["target", "forwarded", "outcome", "status"].includes(key),
          ) &&
          ["allowed-registry", "denied-example"].includes(String(event.target)) &&
          event.forwarded === true &&
          ["response", "upstream-error", "aborted"].includes(String(event.outcome)) &&
          (event.status === null ||
            (Number.isInteger(event.status) &&
              Number(event.status) >= 100 &&
              Number(event.status) <= 599)),
        "Invalid gateway evidence fields",
      );
      return event;
    });
  assert.equal(events.length, 3, "Each application HTTPS leg must reach the gateway exactly once");
  console.log(
    JSON.stringify({
      probe: "computer-gateway-receipts",
      receipts: events.map((event) => ({
        target: String(event.target),
        outcome: String(event.outcome),
        status: event.status,
      })),
    }),
  );
  const refusal =
    trace?.complete === true &&
    trace.namespaceStable === true &&
    trace.events.length === 6 &&
    trace.events.every(
      (event, index) =>
        event.role ===
          ["allowed-before", "denied-example", "allowed-after"][Math.floor(index / 2)] &&
        (index % 2 === 0
          ? event.phase === "START"
          : index === 3
            ? event.phase === "FAILURE" &&
              event.causeCode === "ECONNREFUSED" &&
              event.stepSecurityEndpoint === true
            : event.phase === "RESPONSE" && event.status === 200),
    );
  assert.ok(refusal, "Original host-fetch policy endpoint is UNKNOWN");
  const conversion = events[1]?.outcome === "response" && events[1].status === 500;
  for (const [index, event] of events.entries()) {
    assert.equal(event.target, index === 1 ? "denied-example" : "allowed-registry");
    assert.equal(event.outcome, index === 1 && !conversion ? "upstream-error" : "response");
    assert.equal(event.status, index === 1 ? (conversion ? 500 : null) : 200);
  }
  assert.match(evidence.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(evidence.appPid) && evidence.appPid > 1);
  assert.ok(
    evidence.authorityVerifiedBeforeAfter === true &&
      evidence.tlsAuthorized === true &&
      evidence.syntheticDns === true,
  );
  assert.equal(evidence.allowedBefore, 200);
  assert.equal(evidence.allowedAfter, 200);
  assert.equal(evidence.deniedStatus, conversion ? 500 : 502);
  assert.equal(evidence.deniedTransportFailure, false);
  assert.equal(
    evidence.upstreamStepSecurityBeforeAfter,
    true,
    "Gateway failure without the protected StepSecurity DNS route is UNKNOWN",
  );
}
async function docker(file: string, args: string[]): Promise<string> {
  assert.match(
    env.DOCKER_HOST ?? "",
    /^unix:\/\/\/tmp\/fortipi-docker-[A-Za-z0-9_-]+\/docker.sock$/,
  );
  assert.equal(
    env.DOCKER_CONFIG,
    resolve(dirname((env.DOCKER_HOST ?? "").slice("unix://".length)), "config"),
  );
  return (
    await execute(file, args, { env, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8" })
  ).stdout.trim();
}
async function inspect(file: string, ids: string[]): Promise<Container[]> {
  return (await docker(file, ["inspect", "--format", format, ...ids])).split("\n").map((line) => {
    const value = JSON.parse(line) as Container;
    assert.match(value.id, /^[a-f0-9]{64}$/);
    assert.match(value.image, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(value.pid) && value.pid > 1 && value.running === true);
    assert.ok(typeof value.network === "string" && typeof value.imageRef === "string");
    return value;
  });
}
async function authority(file: string, imageId: string, appId?: string): Promise<Authority> {
  const ids = appId ? [appId] : (await docker(file, ["ps", "--quiet", "--no-trunc"])).split("\n");
  assert.ok(ids.length > 0 && ids.length <= 8 && ids.every((id) => /^[a-f0-9]{64}$/.test(id)));
  const apps = (await inspect(file, ids)).filter(
    (row) => row.image === imageId && row.network.startsWith("container:"),
  );
  assert.equal(apps.length, 1);
  const app = apps[0];
  assert.ok(app);
  const shared = app.network.slice("container:".length);
  assert.match(shared, /^[A-Za-z0-9_.-]{1,200}$/);
  const sidecar = (await inspect(file, [shared]))[0];
  assert.ok(sidecar);
  assert.equal(sidecar.imageRef, sidecarImage);
  return { app, sidecar };
}
async function publicInputs(value: Authority) {
  for (const pid of [value.app.pid, value.sidecar.pid])
    assert.equal(await readlink(`/proc/${pid}/ns/net`), await readlink("/proc/self/ns/net"));
  const startTime = async (pid: number) => {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const value = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
    assert.ok(value && /^[0-9]+$/.test(value));
    return value;
  };
  const root = `/proc/${value.app.pid}/root`;
  const resolvPath = `${root}/etc/resolv.conf`;
  const caPath = `${root}/etc/cloudflare/certs/cloudflare-containers-ca.crt`;
  for (const path of [resolvPath, caPath]) {
    const stat = await lstat(path);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 64 * 1024);
  }
  const resolv = await readFile(resolvPath, "utf8");
  const ca = await readFile(caPath);
  assert.ok(!ca.includes(Buffer.from("PRIVATE KEY")) && new X509Certificate(ca).ca);
  const servers = [...resolv.matchAll(/^\s*nameserver\s+(\S+)\s*(?:#.*)?$/gm)].map(
    (match) => match[1] ?? "",
  );
  assert.ok(
    servers.length > 0 && servers.length <= 3 && servers.every((address) => isIP(address) !== 0),
  );
  const fingerprint = hash(
    Buffer.from(
      JSON.stringify({
        value,
        appStart: await startTime(value.app.pid),
        sidecarStart: await startTime(value.sidecar.pid),
        netns: await readlink("/proc/self/ns/net"),
        servers,
        ca: hash(ca),
      }),
    ),
  );
  return { ca, servers, fingerprint };
}
async function head(
  hostname: "registry.npmjs.org" | "example.com",
  resolver: Resolver,
  ca: Buffer,
) {
  return new Promise<{ status: number | null; transportFailure: boolean; tlsAuthorized: boolean }>(
    (accept) => {
      let tlsAuthorized = false;
      const req = request(
        {
          hostname,
          port: 443,
          path: hostname === "registry.npmjs.org" ? "/pnpm/12.18.0" : "/",
          method: "HEAD",
          family: 4,
          agent: false,
          rejectUnauthorized: true,
          ca: [...rootCertificates, ca],
          signal: AbortSignal.timeout(5000),
          lookup: (host, _options, callback) => {
            resolver.resolve4(host).then(
              (addresses) => {
                const address = addresses[0];
                if (address) callback(null, address, 4);
                else callback(new Error("No app DNS address"), "", 4);
              },
              () => callback(new Error("App DNS unavailable"), "", 4),
            );
          },
        },
        (response) => {
          const status = response.statusCode ?? null;
          response.destroy();
          req.destroy();
          accept({ status, transportFailure: false, tlsAuthorized });
        },
      );
      req.once("socket", (socket) => {
        if (socket instanceof TLSSocket)
          socket.once("secureConnect", () => {
            tlsAuthorized = socket.authorized;
          });
      });
      req.once("error", () => accept({ status: null, transportFailure: true, tlsAuthorized }));
      req.end();
    },
  );
}
async function observeApplicationNamespace(imageId: string): Promise<ApplicationNetworkEvidence> {
  assert.equal(process.platform, "linux");
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const directory = (process.env.PATH ?? "")
    .split(delimiter)
    .find((path) => path.startsWith(resolve(repository, "dist/toolchain/docker-")));
  assert.ok(directory);
  const file = resolve(directory, "docker");
  const before = await authority(file, imageId);
  // This is the workerd namespace's protected upstream route, not the app's DNS descriptor.
  assert.ok(isStepSecuritySinkhole(await resolve4("example.com")));
  console.log(JSON.stringify({ probe: "application-upstream-dns", stepSecuritySinkhole: true }));
  const security = JSON.parse(
    await docker(file, ["info", "--format", "{{json .SecurityOptions}}"]),
  ) as string[];
  const rootless = security.includes("name=rootless");
  const args = [
    "--net",
    "--target",
    String(before.app.pid),
    "--",
    process.execPath,
    self,
    "--client",
    file,
    imageId,
    before.app.id,
    String(before.app.pid),
    before.sidecar.id,
    String(before.sidecar.pid),
  ];
  if (!rootless)
    args.unshift("-n", "--preserve-env=HOME,DOCKER_HOST,DOCKER_CONFIG", "--", "/usr/bin/nsenter");
  const child = await execute(rootless ? "/usr/bin/nsenter" : "/usr/bin/sudo", args, {
    cwd: repository,
    env,
    timeout: 30000,
    killSignal: "SIGKILL",
    maxBuffer: 16384,
    encoding: "utf8",
  });
  const evidence = JSON.parse(child.stdout) as ApplicationNetworkEvidence;
  assert.equal(evidence.imageId, imageId);
  assert.equal(evidence.appPid, before.app.pid);
  assert.equal(
    hash(Buffer.from(JSON.stringify(await authority(file, imageId, before.app.id)))),
    hash(Buffer.from(JSON.stringify(before))),
  );
  assert.ok(isStepSecuritySinkhole(await resolve4("example.com")));
  return { ...evidence, upstreamStepSecurityBeforeAfter: true };
}

export async function verifyApplicationNamespace(
  imageId: string,
): Promise<ApplicationNetworkEvidence> {
  try {
    return await observeApplicationNamespace(imageId);
  } catch {
    console.log(JSON.stringify({ probe: "application-namespace-https", client, unknown: true }));
    throw new Error("Application namespace measurement failed or unknown");
  }
}

if (import.meta.main) {
  let stage = "authority-before";
  try {
    assert.equal(process.platform, "linux");
    assert.equal(process.argv[2], "--client");
    assert.equal(process.argv.length, 9);
    const [file, imageId, appId, appPid, sidecarId, sidecarPid] = process.argv.slice(3);
    assert.ok(file && imageId && appId && appPid && sidecarId && sidecarPid);
    assert.ok(file.startsWith(resolve(repository, "dist/toolchain/docker-")));
    assert.match(
      file.slice(resolve(repository, "dist/toolchain/docker-").length),
      /^[A-Za-z0-9_-]+\/docker$/,
    );
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    assert.match(appId, /^[a-f0-9]{64}$/);
    assert.match(sidecarId, /^[a-f0-9]{64}$/);
    assert.match(appPid, /^[1-9][0-9]*$/);
    assert.match(sidecarPid, /^[1-9][0-9]*$/);
    const before = await authority(file, imageId, appId);
    assert.equal(before.app.pid, Number(appPid));
    assert.equal(before.sidecar.id, sidecarId);
    assert.equal(before.sidecar.pid, Number(sidecarPid));
    const inputs = await publicInputs(before);
    const resolver = new Resolver({ timeout: 1000, tries: 1 });
    resolver.setServers(inputs.servers);
    stage = "allow-before";
    const first = await head("registry.npmjs.org", resolver, inputs.ca);
    stage = "deny";
    const denied = await head("example.com", resolver, inputs.ca);
    stage = "allow-after";
    const last = await head("registry.npmjs.org", resolver, inputs.ca);
    stage = "synthetic-dns";
    const addresses = await Promise.all(
      ["registry.npmjs.org", "example.com"].map((host) => resolver.resolve4(host)),
    );
    // Pinned proxy-everything internet=false synthesizes this route for BOTH targets.
    const syntheticDns = addresses.every(
      (values) => values.length === 1 && values[0] === "11.0.0.1",
    );
    stage = "authority-after";
    const after = await authority(file, imageId, appId);
    const final = await publicInputs(after);
    assert.equal(inputs.fingerprint, final.fingerprint);
    assert.equal(first.status, 200);
    assert.equal(last.status, 200);
    assert.ok(first.tlsAuthorized && denied.tlsAuthorized && last.tlsAuthorized);
    assert.ok(syntheticDns, "Actual gateway application DNS route changed");
    console.log(
      JSON.stringify({
        imageId,
        appPid: before.app.pid,
        authorityVerifiedBeforeAfter: true,
        allowedBefore: first.status,
        deniedStatus: denied.status,
        deniedTransportFailure: denied.transportFailure,
        allowedAfter: last.status,
        tlsAuthorized: true,
        syntheticDns,
        upstreamStepSecurityBeforeAfter: false,
      }),
    );
  } catch {
    console.log(
      JSON.stringify({ probe: "application-namespace-https", client, stage, unknown: true }),
    );
    throw new Error(
      "Application namespace authority, HTTPS controls or vendor attribution unknown",
    );
  }
}
