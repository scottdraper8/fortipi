# Workspaces and execution backends

Workspace authority, immutable files and execution scratch use separate instances of
the existing `WORKSPACES` namespace. The authority name is the public workspace ID.
Children have server-reserved `fortipi:child:` names; public routes never accept
child names or resolve a client-supplied Durable Object ID. The ControlPlane
singleton is `CONTROL_PLANE.getByName("control")`.

Each upload receives a disposable Computer revision store. Explicit mutations
produce a complete snapshot, including independently verified copies of unchanged
files. Files are hashed again before sealing. Publication synchronously checks the
current base, lease, authority clock, fence, credential and executor generations,
reservation and retention bounds, then persists the revision pointer, receipt and
recipient fact together. A losing publication leaves every retained store intact.
Receipt lookup and exact commit retries work after the historical lease expires.
Public receipts contain an opaque stage; private allocation and seal proof remain
at the authority. Facts retain the actual recipient-assigned event coordinates.

Paths must be normalized relative POSIX paths and portable across supported
platforms. Links, special files, aliases, traversal, private `.fortipi` paths,
credentials, Git metadata and excluded dependency/build trees cannot enter a
snapshot. Missing paths do not delete files: deletion is explicit. Reads authorize
committed manifest membership before opening bytes. Clients verify response
length/hash, including the exact response body for a range.

Child I/O and metadata use one FIFO, including lazy read pulls. Authority calls
children outside its FIFO and revalidates before publication. Execution holds a
scratch pin until runtime and synchronization finish; it never holds the FIFO
across a runtime wait. Only an active scratch backend accepts upstream transport
callbacks, through Computer's authentication checks. No generic Computer proxy or
raw Workspace stub is a public API.

The service uses flat RPC ports where their platform types compile. For recursive
execution DTOs it uses the existing authenticated private fetch lane:
`POST /__fortipi/authority/{prepare,start,query,collect}` with the exact respective
ExecutionRequest, PreparedExecution or ExecutionIdentity body. Fact pages use
`POST /__fortipi/facts`. Bodies are bounded to the control limit. The service strips
public `x-fortipi-workspace-context` and constructs `{auth: AuthContext}` itself,
including the current workspace registration. These paths invoke the same methods,
fences and durable ledgers. Direct deeply recursive stub calls hit the platform's
TypeScript recursion limit; they are not the compiled or tested transport here.

An unreferenced expired child is permanently tombstoned at its authority before
physical deletion. Cleanup drains handles, closes Computer and uses supported
`storage.deleteAll()` on the disposable child. The authority and retained revisions
are protected. Reservations remain counted until deallocation is confirmed;
`fs.rm()` is not a reclamation claim. Request-driven cleanup is bounded; the one
workspace alarm expires due upload metadata and stops when no work remains.

Local workspaces store metadata only. Their bytes stay with the authorized owner,
using the ControlPlane's matched HTTPS relay. The executor's explicit local import
scans and approves the root, journals its identity/manifest/revision, then enables
retained-revision reads. A newly created local binding remains unknown until that
proof exists. A caller's credential and the executor's transport credential are
separate identities. Prepare/apply/observe and receipt delivery retain their
original operation identity; a lost apply acknowledgment never authorizes another
mutation. A metadata conflict cannot undo native host effects.

Local read metadata contains an owner-computed chunk inventory on its announced
grid. The authority opens the matched private consumer before requesting the
producer, verifies each bounded chunk and the whole-file hash, and stores no byte
copy. A range's hash and response use separate observational reads. Cancelling a
stream aborts the peer/body and waits for the associated producer request to
settle; ControlPlane interrupts all pairs on that attempt. Public `read()` returns
metadata, while the endpoint opens the stream; neither recursively calls itself.

The same-process transfer stream is the concatenation of changed file bytes in
the enclosing manifest's order, with exact declared lengths. It carries no paths
or additional framing; the authenticated upload record supplies that metadata.
Public and executor transfers continue to use the contract's chunk routes.

## Selecting cloud execution

Cloud JavaScript uses actual `CodemodeBackend`, rooted in `/workspace`, with no
additional host modules, no egress, bounded resources/output and `onInterrupt:
"fail"`. Source is a JavaScript module exporting a default function. It does not
provide a shell. Both Loader and Containers require explicitly selected,
deployment-bound verified paid capabilities and the corresponding optional
binding. Paid status alone neither raises the conservative infrastructure bounds
nor provisions a feature. There are no model-provider usage budgets.

The optional Linux backend uses actual `ContainerBackend` and
`LinuxContainerHost extends withWorkspaceContainer(...)`. The service entry must
export `WorkspaceObject`, the selected host, and `WorkspaceProxy` from Computer.
The parent-owned deployment overlay supplies the `LINUX_CONTAINERS` binding,
SQLite migration, `scheduling_policy: "durable_object"` and
`containers[].images.computerd`. Container scratch is ephemeral; agent state and
committed revisions are independent. Egress defaults to none. No deployment or
model credentials belong in the image or container environment.

Persisted preparation and start intent precede upstream dispatch. Duplicate starts
observe that execution. Query/cancel never launch or restart a replacement host.
Results require terminal evidence, the recorded runtime and complete sync without
required skipped files before collection into a new sealed revision. Unknown,
lost or pending-sync results remain uncertain. Cancellation does not promise
rollback. Computer's container API is experimental.

## Image inputs and verification

With the reviewed Node/pnpm toolchain first on `PATH`:

```sh
node packages/fortipi-contract/scripts/generate.ts --check
pnpm exec tsc -p packages/fortipi-contract/tsconfig.json
node apps/worker/container/build.ts --prepare
node apps/worker/container/build.ts --verify
node apps/worker/test/backends/linux-image.ts --require-fuse
```

The build requires reviewed Docker 29.9.3, Buildx 0.38.2 and embedded BuildKit
0.34.2 using the default driver. The parent owns their installation and isolated
Docker configuration. No local VM is installed by this tranche.

The exact computerd 0.10.0 and Debian image manifests/configs/layers are verified
against foundation metadata. Debian packages use the dated
`20261110T000000Z` snapshot, with exact base versions resolved through immutable
snapshot content addresses where necessary. The freeze includes `Built-Using`
and `Static-Built-Using` source identities, matching archives and source license
hashes. Installation is offline. Raw content-addressed cache entries are rehashed
before reuse; independent archive downloads have bounded concurrency.

`embedded-freeze.json` inventories the actual SEA bootstrap, native addon and
JavaScript assets, their exact source-lock dependencies, native header source and
complete upstream license texts. The modified vendored addon has a separate
source-file inventory. Computer's matching source archive and embedded Node
22.23.4 license are pinned. These observations establish provenance inputs;
reproducible build/relink rights, vulnerability review and license compliance of
the final distribution remain independent release gates.

The builder emits `apps/worker/dist/container/image-metadata.json`, the actual
image archive/inventory, copied licenses and matching source material. Input
digests are never presented as a final built image digest. A local image ID and
archive hash do not establish a published registry manifest digest. CLI packaging
and release must bind the actual selected image and source kit to the release
commit and preserve applicable source/replacement obligations.

`sources-and-notices.tar` contains the exact frozen source archives, embedded npm
archives, Computer source, licenses and recipe, with an internal hash inventory.
The actual image metadata binds the kit hash, final installed source inventory
and copied-license inventory. The release owner must ship and maintain equivalent
access to that kit alongside the image. See
[image source delivery](../apps/worker/container/SOURCE-DISTRIBUTION.md).

Required public build egress: `ghcr.io`, its public layer CDN,
`registry-1.docker.io`, `auth.docker.io`, Docker's public layer CDN,
`snapshot.debian.org`, `codeload.github.com`, `raw.githubusercontent.com` and
`registry.npmjs.org`. The Docker build itself has no network access.

## Evidence boundaries

| Check                 | Independent oracle                                                                                                                           | Observed boundary                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Computer publication  | Independently hashed multi-chunk old bytes survive a losing same-base commit and revoked generation                                          | Actual local workerd/Computer; CP metadata fixture is disclosed                  |
| Receipt and facts     | Identical receipt after mutable lease expiry; same unacknowledged fact and exact acknowledged coordinates                                    | Real workspace SQL; recipient event ingestion belongs to the service             |
| Isolation and cleanup | Sealed write denied; authority-clock expiry denied; observed physical database bytes fall after child deletion; late initialization denied   | Actual local storage; authority tombstone retained                               |
| Crash recovery        | Kill the actual Wrangler process tree after publication and before success response; reopen the same state and independently hash the canary | Managed `--persist-to`; not Cloudflare eviction                                  |
| Sensitivity           | Disposable expiry, generation and seal regressions fail the intended runtime assertions                                                      | Executed against real workerd; no vendor/source patch persists                   |
| JavaScript            | Actual local Loader reads/writes rooted scratch and completes synchronization                                                                | Local isolate emulation; paid-cloud proof still required                         |
| Linux                 | Actual image, host, shell and mounted scratch round trip; inspect mount evidence separately                                                  | Local rootful Docker uses the shim; `--require-fuse` must fail without real FUSE |

Pinned Miniflare grants real FUSE privileges only in its supported Darwin/WSL or
eligible rootless-Linux configurations. The reviewed rootful CI engine does not
establish local FUSE. Do not spoof the OS, patch dependencies or treat health as a
mount test. Paid Cloudflare verification must observe the real FUSE mount and
scratch round trip. `linux-live.ts` consumes an authorized HTTPS probe endpoint
and scoped masked credential; it never deploys.

Run focused tests with `node --test apps/worker/test/workspace/*.test.ts
apps/worker/test/backends/*.test.ts`; run selected disposable mutations with
`node apps/worker/test/workspace/sensitivity.ts`. `createTestHarness` is explicitly
nonpersistent; `recovery-process.ts` manages the separate persistent CLI proof.
Required full integration, paid cloud, eviction and native-device proofs remain
release gates. The npm OSV review does not certify Debian or computerd. Recheck
the exact embedded Node and repository runtime against current security releases
before publication, including the announced November 11, 2026 updates.
