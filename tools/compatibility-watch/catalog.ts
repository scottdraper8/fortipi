export interface Pin {
  file: string;
  keys: string[];
}
export interface Source {
  id: string;
  repo: string;
  ref: string;
  paths: string[];
  manifest?: { path: string; name: string };
  pins: Pin[];
  review: string;
  links: string[];
}

const docs = "cloudflare/cloudflare-docs";
const content = "src/content/";
const worker = "apps/worker/package.json";
const root = "package.json";
const pin = (file: string, ...keys: string[]): Pin => ({ file, keys });
const dependency = (name: string): Pin => pin(worker, "dependencies", name);
const policy = (id: string, paths: string[], review: string, links: string[]): Source => ({
  id,
  repo: docs,
  ref: "production",
  paths: paths.map((p) => content + p),
  pins: [],
  review,
  links,
});
const release = (id: string, repo: string, pins: Pin[], review: string): Source => ({
  id,
  repo,
  ref: "",
  paths: [],
  pins,
  review,
  links: [`https://github.com/${repo}/releases`],
});

// Paths verified against the official repositories on 2026-11-11. This is deliberately
// a compatibility pointer list; the existing supply-chain graph owns security coverage.
export const sources: Source[] = [
  policy(
    "workers-policy",
    [
      "docs/workers/platform",
      "partials/workers/outbound-request-body-limits.mdx",
      "partials/workers/wall-time-limits.mdx",
      "partials/workers/compute-per-request.mdx",
    ],
    "Review Free requests/CPU/memory, transfer and paid plan semantics against conservative infrastructure bounds; account-wide headroom is unknown.",
    [
      "https://developers.cloudflare.com/workers/platform/limits/",
      "https://developers.cloudflare.com/workers/platform/pricing/",
    ],
  ),
  policy(
    "durable-objects-policy",
    ["docs/durable-objects/platform", "partials/durable-objects"],
    "Review SQLite request/row/storage limits, Free exhaustion/reset behavior, alarms and pricing; preserve durable holds and explicit recovery.",
    [
      "https://developers.cloudflare.com/durable-objects/platform/limits/",
      "https://developers.cloudflare.com/durable-objects/platform/pricing/",
    ],
  ),
  policy(
    "containers-policy",
    ["docs/containers/platform", "partials/containers/instance-types.mdx"],
    "Review paid-only availability, instance limits, pricing and outbound transfer before changing Computer/FUSE capability gates.",
    [
      "https://developers.cloudflare.com/containers/platform/limits/",
      "https://developers.cloudflare.com/containers/platform/pricing/",
    ],
  ),
  policy(
    "dynamic-workers-policy",
    ["docs/dynamic-workers"],
    "Review paid-only availability, creation pricing, concurrent workers per Durable Object, custom limits and API/binding semantics.",
    [
      "https://developers.cloudflare.com/dynamic-workers/pricing/",
      "https://developers.cloudflare.com/dynamic-workers/platform/limits/",
    ],
  ),
  policy(
    "workers-compatibility",
    [
      "docs/workers/configuration/compatibility-dates.mdx",
      "docs/workers/configuration/compatibility-flags.mdx",
      "compatibility-flags",
    ],
    "Review compatibility date and nodejs_compat/enable_request_signal/request_signal_passthrough behavior; never migrate configuration automatically.",
    [
      "https://developers.cloudflare.com/workers/configuration/compatibility-dates/",
      "https://developers.cloudflare.com/workers/configuration/compatibility-flags/",
    ],
  ),
  {
    id: "computer-fuse",
    repo: "cloudflare/computer",
    ref: "main",
    paths: [
      "packages",
      "docs",
      "packages/computer/package.json",
      "packages/computerd/package.json",
    ],
    manifest: { path: "packages/computer/package.json", name: "@cloudflare/computer" },
    pins: [dependency("@cloudflare/computer")],
    review:
      "Review Computer exports, WorkspaceProxy, backends, remote execution, computerd/FUSE protocol, native ABI and notices. Companion daemon version is not established by the npm client pin.",
    links: [
      "https://github.com/cloudflare/computer/blob/main/packages/computer/CHANGELOG.md",
      "https://github.com/cloudflare/computer/blob/main/packages/computerd/CHANGELOG.md",
    ],
  },
  {
    id: "agents-lifecycle",
    repo: "cloudflare/agents",
    ref: "main",
    paths: ["packages/agents", "packages/agents/package.json", "docs/agents/harnesses/pi.md"],
    manifest: { path: "packages/agents/package.json", name: "agents" },
    pins: [dependency("agents")],
    review:
      "Review PiHarness/Lifecycle, SQLite adapter, wake/eviction/recovery and optional peer compatibility. Real Pi owns the durable loop.",
    links: [
      "https://github.com/cloudflare/agents/blob/main/packages/agents/CHANGELOG.md",
      "https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md",
    ],
  },
  {
    id: "pi-runtime",
    repo: "earendil-works/pi",
    ref: "main",
    paths: [
      "packages/agent",
      "packages/ai",
      "packages/chord",
      "packages/codemode",
      "packages/durable",
      "packages/env",
      "packages/mcp",
      "packages/schema",
      "packages/telemetry",
      "packages/tui",
      "packages/durable/package.json",
    ],
    manifest: { path: "packages/durable/package.json", name: "@earendil-works/pi-durable" },
    pins: ["pi-durable", "pi-ai", "pi-schema", "chord", "pi-codemode", "pi-telemetry"]
      .map((name) => dependency(`@earendil-works/${name}`))
      .concat([
        pin("packages/fortipi-cli/package.json", "dependencies", "@earendil-works/pi-ai"),
        pin("packages/fortipi-tui/package.json", "dependencies", "@earendil-works/pi-tui"),
      ]),
    review:
      "Review experimental durable APIs, exports, hooks, task replay/cancellation, SQLite storage and provider-auth/runtime APIs across the pinned Pi family; minor/patch labels do not prove safety.",
    links: [
      "https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md",
      "https://github.com/earendil-works/pi/blob/main/packages/durable/README.md",
    ],
  },
  {
    id: "wrangler",
    repo: "cloudflare/workers-sdk",
    ref: "main",
    paths: ["packages/wrangler", "packages/wrangler/package.json"],
    manifest: { path: "packages/wrangler/package.json", name: "wrangler" },
    pins: [
      pin(worker, "devDependencies", "wrangler"),
      pin("packages/fortipi-cli/package.json", "dependencies", "wrangler"),
    ],
    review:
      "Review Wrangler deployment/configuration APIs and image schema against installed CLI prepare/deploy behavior before adoption.",
    links: ["https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md"],
  },
  release(
    "libfuse",
    "libfuse/libfuse",
    [
      pin("tools/unstale/platform-tools.json", "fuse", "fuse3"),
      pin("tools/unstale/platform-tools.json", "fuse", "libfuse3"),
    ],
    "Review upstream FUSE API/ABI, mount/unmount, security and kernel compatibility changes against the exact packaged Debian source and patches. Computer's vendored addon is separate. Verify canonical native pins match the final image; an upstream reference alone does not establish installed-version security.",
  ),
  release(
    "workerd",
    "cloudflare/workerd",
    [pin(worker, "devDependencies", "@cloudflare/workers-types")],
    "Review runtime releases and type/binding changes together with the locked Wrangler/workerd graph; a type package version is not runtime compatibility proof.",
  ),
  release(
    "node",
    "nodejs/node",
    [pin(root, "fortipi", "toolchain", "node")],
    "Review Node releases for supported runtime/API and native ABI changes; latest release may be another major. Existing security review remains authoritative.",
  ),
  release(
    "pnpm",
    "pnpm/pnpm",
    [pin(root, "packageManager")],
    "Review pnpm lock/install/lifecycle and trust-policy behavior before changing the exact manager pin.",
  ),
  release(
    "typescript",
    "microsoft/typescript-go",
    [pin(root, "devDependencies", "typescript")],
    "Review compiler/tooling contract changes before changing the pinned strict compiler.",
  ),
  release(
    "native-pty",
    "microsoft/node-pty",
    [pin(root, "devDependencies", "node-pty")],
    "Review native ABI/build and terminal behavior; validate actual native/PTY and installed consumers before adoption.",
  ),
];
