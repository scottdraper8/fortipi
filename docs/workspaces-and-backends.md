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

Public workspace operations acquire, renew and release explicit leases through
ControlPlane. Acquisition binds the expected base and canonical `workspace-lease`
digest. Computer's non-job holder is the logical workspace ID at its binding
version; it does not require an execution backend. Private records retain the
target kind so an unrelated executor with the same ID cannot revoke that holder.
Renew/release receipts bind their business request IDs, independently of the
transport request ID. A renewal can extend beyond initial reservation admission
expiry, within the original deadline, current credential/grant expiry and 30-second
lease bound. Exact acknowledgments remain historical observations; released or
superseded leases cannot regain authority through a cached response.

Paths must be normalized relative POSIX paths and portable across supported
platforms. Links, special files, aliases, traversal, private `.fortipi` paths,
credentials, Git metadata and excluded dependency/build trees cannot enter a
snapshot. Missing paths do not delete files: deletion is explicit. Reads authorize
committed manifest membership before opening bytes. Clients verify response
length/hash, including the exact response body for a range.
Metadata responses recheck current credential/grant authority after awaited
observations and before returning the result.

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

Private publication and store observations use the caller's actual reserved
workspace action and the saved allocation/lease/reservation scope. A writer can
copy retained bytes into a full new revision and recover its publication receipt
without receiving public read permission. Public file/stat/manifest/receipt reads
still require `workspace.read`.

Private `getReceipt` can also recover an exact known commit with the current
registered writer's retained reservation scope. It verifies the saved upload or
local intent, original job/operation/base/lease identity, current agent/conversation/
target grant and credential/executor floors. Historical expiry does not renew or
rewrite that authority. Receipt lookup is observational and does not initiate
publication or cleanup. The public `getCommitReceipt` path always requires read.

When a commit reply is lost before its computed digest is known, private fact
paging can expose only the intended recipient's actual retained publication fact
under that same write authority. The fact must match the stored receipt and its
original reservation; write does not authorize arbitrary facts. Read-authorized
fact pages and acknowledgments also require one current grant covering the actual
workspace, action, recipient agent and fact conversation. Acknowledgments retain
their original event coordinates on retry. The service still compares each
receipt/fact with its known job and binding: `CommitLookup` carries only workspace,
commit ID and digest, not independent job or binding coordinates.

`POST /__fortipi/terminal-proof` accepts at most 64 KiB of the existing
`JobCommitted` JSON, with the same server-constructed context header. It checks
the historical acquired lease, known job/execution/operation reservation, current
registered caller's scope and floors, and an actual projected receipt or retained
unchanged base. Committed proof requires write; unchanged proof permits read or
write. Success returns the same validated JSON with `Cache-Control: no-store`.
A current authorized recovery credential may differ from the historical job's
credential; historical lease expiry is not renewed or rewritten. ControlPlane
still checks the native assignment digest, and AgentSession must prove the actual
terminal version/event coordinates. This workspace proof does not attest those
independent records or native execution.

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

Before local upload allocation, the authority requires the keyed executor's actual
numeric transfer limits. It checks the complete proposed manifest, ordered
mutations, every put including later superseded puts, announced chunk grids and
aggregate staging bytes. Missing observations fail admission. Equal file hashes
may share a verified blob only within that upload; final paths retain separate
membership. Empty files have no public PUT. Job transfers use the execution ID
retained in their actual reservation.

Local read metadata contains an owner-computed chunk inventory on its announced
grid. The authority opens the matched private consumer before requesting the
producer, verifies each bounded chunk and the whole-file hash, and stores no byte
copy. A range's hash and response use separate observational reads. Cancelling a
stream aborts the peer/body and waits for the associated producer request to
settle. When cancellation reaches ControlPlane, it interrupts all pairs on that
attempt. Actual owner4 testing found that Wrangler's local HTTP proxy can lose
that signal; its bounded timeout is a fallback, and immediate integrated
cancellation remains an open transport gate. Public `read()` returns
metadata, while the endpoint opens the stream; neither recursively calls itself.

Cloud output is retained in the workspace's artifact ledger. If that ledger has
no matching artifact, the authority delegates to the existing private ControlPlane
fetch lane: `GET /internal/artifacts/{workspaceId}/{artifactId}`, with the current
registered reader's `AuthContext` in server-constructed `X-Fortipi-Context`.
Revision/range metadata and the cancellation signal are preserved; internal
authority headers are never exposed. The response remains bounded streaming data.
ControlPlane owns native artifact membership and current job/executor/resource
authorization. Reads use current reader authority and immutable original job
identity, without reconstructing a historical lease or restarting a process.

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

Execution observation, cancellation and collection match the entire immutable
prepared identity, including its original base, deadline and lease fence. Only
the lease's mutable expiry/version observations may differ after renewal. Saved
cloud output can be read with `artifacts.read` and its agent/conversation scope;
the existing private store fetch lane rechecks exact output membership at the
authority without granting workspace access. Stream delivery rechecks current
authority after each awaited read before exposing another chunk.
Scratch materialization retries verify an existing file's type, mode, size and
full hash against the committed input; they never overwrite a mismatching file.

Container HTTP uses the existing Durable Object `fetch(Request)` transport.
The owning host calls its native TCP-port Fetcher inside that same object;
neither the TCP capability nor a Request's signal crosses custom JavaScript RPC.
The host persists the actual successful SDK start identity and prepared image
before acknowledgment. It checks the private expected identity, current allocation,
selected Linux configuration and running/exit state around HTTP, and removes the
private header before contacting computerd. Start and HTTP acquisition share a
queue through response headers so a pending connection cannot target a later
owned start. Native bodies, streams and WebSocket upgrades pass through without
buffering. Query-only mode never starts or restarts a replacement.
The upstream observation API does not expose a remote runtime UUID independently
of start. Exit/eviction and known recorded-identity changes fail closed; external
replacement identity remains an explicit runtime-proof limit.

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
The builder retains Buildx's actual manifest/config metadata, checks the loaded
config ID, and records `builtManifestDigest`; `registryDigest` stays null until
publication supplies an observed registry digest. This uses Docker's documented
[build metadata output](https://docs.docker.com/reference/cli/docker/buildx/build/#write-build-result-metadata-to-a-file-metadata-file).

`sources-and-notices.tar` contains the exact frozen source archives, embedded npm
archives, Computer source, licenses and recipe, with an internal hash inventory.
Descriptor filenames and every referenced sibling are checked against the shipped
canonical source names. The kit includes the complete tracked FortiPi source and
its commit, exact platform metadata, manifest/lock and tooling setup instructions.
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
