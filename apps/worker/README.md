# FortiPi Worker

The Worker hosts the ControlPlane, AgentSession and WorkspaceObject authorities. `WorkspaceProxy` comes from Cloudflare Computer; Linux execution uses the real container host. Public requests use the generated contract catalog. Internal authority paths are inaccessible through the public router.

AgentSession composes the pinned PiHarness, Lifecycle and WebSockets capabilities. Pi and application records share the queued Durable Object SQLite adapter. Lifecycle owns alarms; Pi owns task execution. The JSON stream disables the capability RPC protocol and rejects Cap'n Web upgrades before acceptance.

An admission reserves infrastructure capacity and persists its operation, message and task identities before submitting to Pi. Retries recover the original receipt. Cancellation records a durable intent; it does not promise rollback. Uncertain execution preserves its original assignment and queries that execution with an exact retained Workspace renewal observation. Success requires committed result evidence and a durable application event.

The selected model comes from the persisted Agent configuration through an authenticated private ControlPlane fetch after readiness. Factory startup performs no ControlPlane network call or OAuth refresh. API-key bindings and the ControlPlane OAuth delegate remain separate from application and executor credentials. Model usage budgets are not implemented.

Pi reads the complete current Models registry through its supported dynamic accessor, keeping credential resolution with the registry that created each provider. A bounded nonsecret catalog and indexed outstanding admission/allocation configurations restore required providers after process replacement. A provider authentication-mode change conflicts while outstanding work needs an incompatible configuration. Environment keys never select a model or provider implicitly.

One actor controller bounds every installed provider and the public Models handoff:256KiB encoded message/event and queued bytes,64KiB tool arguments,16,384 events,60 seconds and32MiB cumulative encoded work per stream. Its concurrent provider lanes share the configured infrastructure admission limit across registry replacements. Cancellation retains a lane until the provider's public result settles. A100KiB ASCII answer with256-byte deltas passes locally;32-byte deltas reach work pressure. The original100KiB public accounting case with the pinned faux provider's12–20-byte deltas still fails at the bounded model facade, before a final answer. This remains an acceptance gap. These are infrastructure limits, with no provider token, spend or weekly budget. An admitted Pi run permits four tool rounds; its normal retained-input continuation remains available after the turn limit.

The router's physical ControlPlane calls depend on the route owner. Every authenticated JSON route first calls `authenticate`. Agent and Workspace routes also register the actual recipient before calling it. Control-owned JSON routes call `handleApi` directly after authentication; they do not register an unrelated Agent or add another router authorization call. Streams go directly to ControlPlane's atomic ticket redemption and query-free forwarding. Control-owned byte routes currently authenticate in the router and again in the separate owner fetch; both physical calls count.

| Operation                         | Additional ControlPlane calls in the Agent owner                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New conversation                  | Current creation authorization, selected-model fetch, physical storage sample, stable capacity reservation, current authorization before Pi allocation, settlement        |
| New message/steer                 | Current submission authorization, selected-model fetch, physical storage sample, stable capacity reservation, current authorization before Pi admission, later settlement |
| Identical message retry           | Current submission authorization; original receipt returns without another model lookup or reservation                                                                    |
| Conversation/event/task/job reads | Current owner authorization; task/job IDs also require deriving and registering their actual conversation scope                                                           |
| Job dispatch/recovery             | Current scoped authorization and the phase's actual target/lease/prepare/query/result calls; retained identities remain stable                                            |

Physical storage samples use ordinary admission, including the Agent submit/job phases and Workspace freshness work. Exhausted ordinary admission holds new growth; samples cannot consume retained-completion repair headroom. Active queries coalesce with lease renewal rather than polling every five seconds. One actual Free principal-pressure case preserves an admitted native job's query, renewal, lease-update delivery, facts, result delivery, receipt and terminal closure with the sampler integration. Cloud and paid-backend pressure remain separate acceptance gates. Repeated immutable snapshot reads and the two physical CP admissions per executor byte request remain performance work.

The generated catalog currently has74 operations. The five assigned-job snapshot/upload operations require the executor audience and forward to ControlPlane.fetch. Native pending consent projects an exact operation-bound local-policy wait; allowed preparation clears that wait without claiming a running process. The Agent rejects delayed phase regression using its durable job version. Local qualification includes a file-bearing Computer snapshot through native execution, Workspace CAS, receipt and terminal confirmation. A31-file Free preparation preserves its admitted identity through two real60-second rate backoffs and renewed leases; that result establishes correctness, not acceptable preparation latency.

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

Implementation and qualification are in progress. Agent allocation floors and queued public SQLite samples now cover the actual100KiB answer countercase in a scoped client flow; floors remain estimates and only validated object totals are reported measured. Aggregate prospective growth, maximum admitted completion, fork/export bounds and pre-entry storage pressure still need qualification. The raw outer commit guard was removed from production because rollback erased acknowledged competing writes; rejected-spike fixtures retain the counterevidence. Local changed-native, receipt-first and empty-Workspace/Agent backup compositions pass. Abrupt dispatched recovery and release proofs remain required. See [protocol and recovery](../../docs/protocol-and-recovery.md).
