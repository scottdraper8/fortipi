# FortiPi Worker

The Worker hosts the ControlPlane, AgentSession and WorkspaceObject authorities. `WorkspaceProxy` comes from Cloudflare Computer; Linux execution uses the real container host. Public requests use the generated contract catalog. Internal authority paths are inaccessible through the public router.

AgentSession composes the pinned PiHarness, Lifecycle and WebSockets capabilities. Pi and application records share the queued Durable Object SQLite adapter. Lifecycle owns alarms; Pi owns task execution. The JSON stream disables the capability RPC protocol and rejects Cap'n Web upgrades before acceptance.

An admission reserves infrastructure capacity and persists its operation, message and task identities before submitting to Pi. Retries recover the original receipt. Cancellation records a durable intent; it does not promise rollback. Uncertain execution preserves its original assignment and queries that execution with an exact retained Workspace renewal observation. Success requires committed result evidence and a durable application event.

The selected model comes from the persisted Agent configuration through an authenticated private ControlPlane fetch after readiness. Factory startup performs no ControlPlane network call or OAuth refresh. API-key bindings and the ControlPlane OAuth delegate remain separate from application and executor credentials. Model usage budgets are not implemented.

Pi reads the complete current Models registry through its supported dynamic accessor, keeping credential resolution with the registry that created each provider. A bounded nonsecret catalog and indexed outstanding admission/allocation configurations restore required providers after process replacement. A provider authentication-mode change conflicts while outstanding work needs an incompatible configuration. Environment keys never select a model or provider implicitly.

The router's physical ControlPlane calls depend on the route owner. Every authenticated JSON route first calls `authenticate`. Agent and Workspace routes also register the actual recipient before calling it. Control-owned JSON routes call `handleApi` directly after authentication; they do not register an unrelated Agent or add another router authorization call. Streams go directly to ControlPlane's atomic ticket redemption and query-free forwarding. Control-owned byte routes currently authenticate in the router and again in the separate owner fetch; both physical calls count.

| Operation                         | Additional ControlPlane calls in the Agent owner                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| New conversation                  | Current creation authorization, selected-model fetch, stable capacity reservation, current authorization before Pi allocation, settlement        |
| New message/steer                 | Current submission authorization, selected-model fetch, stable capacity reservation, current authorization before Pi admission, later settlement |
| Identical message retry           | Current submission authorization; original receipt returns without another model lookup or reservation                                           |
| Conversation/event/task/job reads | Current owner authorization; task/job IDs also require deriving and registering their actual conversation scope                                  |
| Job dispatch/recovery             | Current scoped authorization and the phase's actual target/lease/prepare/query/result calls; retained identities remain stable                   |

The actual six-request initial Free journey uses25 physical ControlPlane calls in the local fixture. This includes model selection and two settlements; background repair and job execution add calls. Active queries coalesce with lease renewal rather than polling every five seconds. One actual Free principal-pressure case now preserves an admitted native job's query, renewal, lease-update delivery, facts, result delivery, receipt and terminal closure. Cloud and paid-backend pressure remain separate acceptance gates.

The generated catalog currently has74 operations. The five assigned-job snapshot/upload operations require the executor audience and forward to ControlPlane.fetch. Native pending consent projects an exact operation-bound local-policy wait; allowed preparation clears that wait without claiming a running process. The Agent rejects delayed phase regression using its durable job version. Actual mixed transport qualification awaits the frozen owner implementations.

Agent exports retain immutable bounded NDJSON with supported committed Pi entries, canonical messages and allowlisted public task/job/approval records. The descriptor reports the actual Agent and retained conversations, measured byte length and SHA-256. Private peer copying requires the retained logical export/backup action and exact snapshot scope. Public downloads separately require administrator `artifacts.read`. Exports exclude credential, provider-auth and socket-authority records and do not reclaim storage.

Use the repository's pinned toolchain and normal frozen installation. Focused checks are:

```sh
pnpm exec tsc -p apps/worker/tsconfig.json --noEmit
pnpm run schema:check
node --test apps/worker/test/{agent,execution,models,api}/*.test.ts
node apps/worker/test/agent/sensitivity.ts
pnpm --dir apps/worker exec wrangler deploy --dry-run --outdir dist
```

The abrupt-recovery tests launch real local Wrangler processes with `--persist-to`, kill workerd with `SIGKILL`, and reopen the same state. In-process Wrangler fixtures do not prove persistence. Faux model tests establish orchestration behavior; they do not establish live Workers AI, external-provider, native-filesystem or paid-backend qualification.

Implementation and qualification are in progress. Current metadata reservations undercount actual variable Pi/SQLite storage; a100KiB answer countercase fails install-wide accounting. The adopted operational-storage plan requires measured object totals, pending growth and bounded completions; its Agent implementation and actual ControlPlane sampling composition remain open. The raw outer commit guard was removed from production because rollback erased acknowledged competing writes; rejected-spike fixtures retain the counterevidence. Local changed-native, receipt-first and empty-Workspace/Agent backup compositions pass. File-bearing mixed Computer/native execution, abrupt dispatched recovery and release proofs remain required. See [protocol and recovery](../../docs/protocol-and-recovery.md).
