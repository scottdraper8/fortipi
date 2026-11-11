# FortiPi native executor

Independent outbound Node26.13 executor for macOS, Linux and Windows. It imports
only `fortipi-contract/executor` and Ajv2020; it never opens Pi storage or embeds a
client, server, model provider or deployment tool. An executor credential is
required. Management credentials cannot register a native executor.

Native commands run as the daemon OS user, with access to that user's files
outside cwd and to the network. **This is host execution, with no OS sandbox.**
Traversal checks, environment filtering and approval do not confine arbitrary
programs. Native execution defaults to disabled; `requireConfinement` rejects
this backend on every platform.

```sh
fortipi-executor init --profile /protected/path/profile.json
fortipi-executor import --root-binding-id ROOT --request-id IMPORT_ID --profile /protected/path/profile.json
fortipi-executor import --root-binding-id ROOT --request-id IMPORT_ID --approve EXACT_PROPOSAL_DIGEST --profile /protected/path/profile.json
fortipi-executor policy --profile /protected/path/profile.json --trusted-host --accept-daemon-user-files-and-network
fortipi-executor start --profile /protected/path/profile.json
fortipi-executor status --profile /protected/path/profile.json
fortipi-executor resume-infrastructure --profile /protected/path/profile.json
fortipi-executor approvals list --profile /protected/path/profile.json
fortipi-executor approve JOB_ID --digest EXACT_LOCAL_DIGEST --profile /protected/path/profile.json
fortipi-executor reject JOB_ID --digest EXACT_LOCAL_DIGEST --profile /protected/path/profile.json
fortipi-executor policy --disable --profile /protected/path/profile.json
```

The management CLI writes the scoped credential directly to a protected profile;
do not put tokens in argv or logs. `init` provisions a new durable identity once.
It refuses existing identities. Missing/corrupt ledgers require explicit recovery
and a newly authorized execution generation; restarting never recreates them.
The profile's `ledgerId` selects its private sibling state directory. Default
per-user state/registry locations are Application Support/FortiPi/Executor on
macOS, XDG state/fortipi/executor on Linux, and LocalAppData/FortiPi/Executor on
Windows. Profiles and state must be outside workspaces and checkouts. HTTPS is
required; `--local-test` permits loopback HTTP only.

`Profile` and `Binding` are exported TypeScript interfaces. A version1 profile
contains origin/deploymentId, executorId/executorGeneration, the separate
credential ref and token, ledgerId, explicit resource grants, local policy and
limits, and root bindings. Each binding contains rootBindingId, workspaceId,
bindingVersion, native path, revision, manifestHash and local/computer provider
kind. Never use a path alone as a remote binding identity. `LocalPolicy.rules`
are explicit operator configuration for a workspace/root/tool/exact argument
digest; remote approvals cannot create these rules or change local decisions.

## Durable execution and recovery

SQLite FULL transactions persist a unique job/body identity, exact local decision
and winning start intent before spawn. Dedicated rollback-journal databases hold
lifetime exclusive locks for the ledger and canonical filesystem root. A separate
per-user registry binds each executor execution generation to its ledger before
provisioning and prevents a replacement profile/root from bypassing lost history.
It also prevents path aliases from registering a new ledger for an existing
root. Use a local disk whose locking behavior has been verified;
network/distributed filesystems are outside the supported storage configuration.

The canonical operation/assignment hashes must validate before admission or
approval. The additional received-body hash detects conflicting duplicates.
Renewed expiry/version and socket epochs do not change immutable identity.
Credential generation, executor generation, binding version and connection epoch
are separate. Reconnecting changes only the connection epoch and sends queries
and persisted deliveries. An absent attempt is unknown. Cancellation before
assignment stores a no-late-start tombstone. A previous start intent or running
row becomes unknown after restart; PID reuse never authorizes a kill or a rerun.

Output and result deliveries remain in the bounded ledger until their exact
persisted acknowledgments. Local output artifacts have explicit owner references
and remain unavailable when that owner is offline. Process exit, chunk delivery,
result receipt, workspace receipt acknowledgment and terminal committed outcome
are different events. No transport acknowledgment reports committed success.
Capacity exhaustion preserves dedup/receipt history and refuses new work.

POSIX uses an explicit `/bin/sh`, `shell:false` and a process group, with bounded
TERM/KILL escalation. Windows uses the explicit SystemRoot Windows PowerShell
executable, no profile/interactive startup, UTF-16LE encoded commands and
`taskkill /T` with force escalation. Cancellation uses only a live ChildProcess
from this daemon incarnation. Descendants can escape a group/tree or outlive its
leader; cancellation cannot roll back effects and may report unknown.
Shutdown stops admissions, attempts cancellation and drains pending result and
transfer work before closing SQLite. Unconfirmed live children retain unknown
status and quarantined roots; a later exit cannot publish through a closed ledger.

## Workspace and transport boundaries

Cloud revisions are verified into private per-execution scratch. Staging uploads
explicit puts/deletes/mkdirs and verifies hashes, lengths and the final manifest.
Only the service can commit a stage. Failed or uncertain transfer retains its
original request/upload/commit identities; retry performs staging or observation,
never native execution. Missing scratch is an error, never an empty diff.

Local workspaces use prepare, one durable journaled apply claim, observe, metadata
commit, receipt delivery and receipt acknowledgment. Root pins survive lost
acknowledgments. Native execution enters through job.assign; workspace apply
never launches a process. Repeated apply is observational. Partial/unknown/drift
quarantines the root. Observe and receipt recovery may use an expired historical
lease under current authority, while apply and commit require a live lease.
The original caller credential and lease identity remain part of that journal;
the CP authenticates a newly authorized reader separately. Rewriting historical
scope or changing the executor generation cannot recover or apply that operation.
Current bytes are never silently substituted for unavailable historical content.
An exact repeated preparation can carry a newer authoritative lease observation
while apply awaits filesystem work. It returns the same preparation ID and updated
expiry, preserves the effect journal, and cannot revive an already expired lease.
Subsequent effects use the persisted renewal; changing scope or staged metadata
still conflicts.

File bytes travel through bounded authenticated HTTPS chunk transfers. The relay
contains transient bytes only; no bytes travel in WebSocket frames and local
files do not become cloud canonical copies. No redirects or arbitrary URLs are
followed. Hash, length, attempt, direction, generation, workspace, consumer and
job correlation are independently checked. Infrastructure pressure pauses bounded
retries while retaining operation identity. Effective limits are the minimum of
local and discovered bounds. A paid account raises no limit or enables a backend
automatically. There are no model-provider token/hour/week budgets.

Native output references record the actual stdout/stderr collector stream and
its complete hash/grid. Retained artifact reads use the current authorized
reader's credential separately from the immutable original job identity. An
expired job lease or later workspace revision does not invalidate those retained
bytes; mutable local staging keeps its original credential and lease checks.
The executor verifies the exact retained member, stream, owner, job/execution,
binding/base and current caps, then reads the protected file with a strict bound.
It verifies the actual whole-file hash and chunk inventory before producing bytes.

Output transfer opens receive a correlated `transfer.status` using the original
request/transfer/attempt. `verified` follows actual source verification and chunk
acknowledgments; `interrupted` reports only acknowledged chunks/bytes. Even an
empty reference needs its actual private empty file before acknowledgment. The
collector omits empty streams. Range consumers still request the full native
artifact descriptor and verify/drain it before slicing in the service. Producer
status supplements actual relay byte verification; it is not a workspace receipt.

Quota pressure, known retry/reset timestamps and Retry-After delays are retained
in SQLite across restart. The latest known bound controls retries; long delays
are not shortened. Storage pressure without a known retry/reset stays held for
explicit operator recovery, with no assumed daily reset. `status` exposes the
redacted pressure and hold state. After resolving the reported cause, stop the
daemon, run `resume-infrastructure --profile /protected/path/profile.json`, and
start it again. This explicit local action clears the persisted pause, preserves
pending job identities and permits reconnect; it does not claim account headroom
or replay effects. It refuses while the daemon holds its SQLite lifetime guard.
Ordinary status, restart and reconnect never clear the hold. The exported
`HttpTransport.clearPressure()` provides the same persistence operation to local
embedders, which must stop their own transport before using it.

Local reads first return metadata with hashes computed from retained revision
bytes, then accept an exactly correlated transfer descriptor to produce chunks.
The announced grid is immutable and no larger than negotiated `chunkBytes`;
file/artifact caps also respect the grid's 256-chunk metadata bound. Staged writes
verify all ordered puts, including superseded and empty files. Empty files send
no public PUT. A verified SHA can serve multiple declared paths only inside the
same validated upload scope. Oversize control metadata fails before effects.
Identity, resource or capacity profile edits require a restart and reconciliation;
the running daemon fails closed when it observes such an edit. Local consent and
approval policy are reloaded before admissions. Byte loops recheck current caps.

Paths are NFC relative POSIX names. Reserved Windows aliases, ADS, traversal,
case collisions, secrets/build caches, links, junctions/reparse points, externally
aliased hardlinks and special files are rejected. Native reads use checked
handles/no-follow where available and check ancestor/entry identity and drift.
Detected replacement fails closed. Node cannot atomically bind every directory
component and operation on all three operating systems; an arbitrary process
with the same OS user's access can still race these checks or write outside the
root. Root trust remains necessary. POSIX modes or restrictive current-user/SYSTEM
DACLs protect state. ACL inspection alone is not a demonstrated other-user denial.
The hosted native CI job separately runs `test/fixtures/cross-identity.ts` under
an existing POSIX `nobody` UID or a disposable Windows account in Users, without
administrator membership. The child must read a public control and receive only
permission-denied errors when opening the protected profile, directory, SQLite
database and actual crash journal. An exported protected profile isolates file
permissions from the directory barrier; widening only that synthetic file must
allow access, and restoring protection must deny it again. No file contents or
account passwords are logged; the account and synthetic files are removed in
`finally`. The fixture refuses local/self-hosted execution, uses noninteractive
sudo on POSIX and in-process random credentials on Windows, and has a two-minute
CI step bound. Its actual three-OS results are required in the canonical report.
POSIX uses a SHA-256-checked copy of the current public Node executable inside
the synthetic public lab, so the runner's home permissions cannot prevent the
positive control from starting. It changes no runner-home permissions. Failed
launch/control diagnostics disclose only fixed categories, including when
Windows PowerShell wraps stderr in CLIXML.
Windows sends the fixed probe program through redirected stdin and closes it;
the credentialed child command stays below CreateProcessWithLogonW's 1024-character
limit. The account password remains in process memory and SecureString.
Windows permission utilities use typed SID ACL operations from .NET Framework
and direct filesystem attributes, without cmdlet module autoload or account-name
translation. The native diagnostic emits bounded stage timings without identities
or paths; it retains the same per-process protection timeout.
Rejected DACLs report bounded owner-category/rule-mask diagnostics without SIDs or
paths. Only known SQLite sidecars under a strictly protected database and parent
may tighten an inherited DACL whose owner is exactly the process token's default
owner and whose only allow entries give current-user/SYSTEM full control. The
adapter repeats eligibility before protecting the copied entries and setting the
owner to the current user, then verifies identity, unchanged bytes and strict
protection before SQLite opens it. Foreign owners/entries, links and unsafe
parents are rejected without repair. This path requires actual Windows evidence.

## Reproduction and evidence limits

From the repository, with the reviewed toolchain first on PATH:

```sh
node packages/fortipi-contract/scripts/generate.ts --check
pnpm exec tsc -p packages/fortipi-contract/tsconfig.json
pnpm run build:executor
pnpm run typecheck:executor
pnpm exec tsc -p packages/fortipi-client/tsconfig.json
pnpm exec tsc -p packages/fortipi-tui/tsconfig.json
pnpm exec tsc -p tsconfig.tools.json --noEmit
pnpm run test:executor
node packages/fortipi-executor/test/mutations.ts
```

Tests use actual SQLite, files, subprocesses and HTTP streams. The HTTP fixture
supplies a synthetic authority; it does not prove ControlPlane/workerd durability.
Local disposable mutations remove the winning start predicate and the complete
manifest comparison, then require the independent duplicate-claim and revision
oracles to fail. Restored baselines are rerun. Evidence is about those defects
and environments, not test count.

`test/remote.ts --endpoint ORIGIN --credential-fd 3` requires an actual endpoint
and inherited bounded JSON containing the scoped token, executor/generation,
deployment, credential ref and explicit resources. It performs discovery,
real ticket/registration and one-use ticket rejection with native WebSocket.
It fails when the descriptor or endpoint is absent. It does not claim all
deployed job, revoke, transfer or device-replacement scenarios. Thread10 owns
those integrated proofs and packed-install acceptance.

The canonical Phase3 Thread8 report records the exact commit, commands, native
platform observations, mutation results and missing evidence. Three-OS product
proof, the separate cross-identity denial probe and actual Worker/relay/revocation
composition remain required evidence; macOS fixtures do not prove Windows behavior.
