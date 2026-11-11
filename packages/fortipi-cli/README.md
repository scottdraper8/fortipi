# FortiPi CLI

Contract preparation for the management CLI. Node 26.13.0 is required. Worker assets and installed/deployed qualification await the completed durable service; `prepare` fails explicitly when genuine assets are absent. No substitute Worker is included.

After compiling the repository, `node packages/fortipi-cli/dist/bin.js --help` lists the current interface. Every command has `--help`; errors go to stderr with codes 1 (failure/uncertainty), 2 (input), 3 (setup prerequisite), 4 (version conflict), or 130 (cancelled). Results are bounded JSON. Credentials are never command arguments or JSON results.

Start from [the canonical example](templates/operator-config.example.json), replace its deployment and device selections, then run:

```sh
fortipi init --from operator-source.json --config operator.json --non-interactive
fortipi config validate --config operator.json --json
```

Infrastructure failures include curated resource, measurement kind, limits, supplied reset/retry times and operator action on stderr. Remote messages, free-text reasons and resource identifiers are omitted. Unknown measurements and absent resets stay unknown; storage errors do not imply a daily reset.

`runtime` follows the shipped `Configuration` schema. Workspace, execution, routing and models are independent selections. Free/unknown defaults use the contract's conservative bounds. Paid Loader/Containers require explicit canonical capability declarations; local validation does not prove Cloudflare account entitlement. The example requires a separately registered, authorized native executor and does not grant native shell permission.

Management uses an exact-origin protected application profile, selected with `--profile NAME`. Inputs to mutations are non-secret canonical DTO files. Credential issuance reserves and syncs its protected output before contacting the authority; stdout contains metadata only. A lost response leaves its request ID for recovery. Never remint blindly. Revocation may return durable `pending` and must be queried until complete.

Pi OAuth uses only the public supported OpenAI, Anthropic and separate OpenAI Codex factories, in memory. Browser/copy/device instructions require an attached interactive terminal. OAuth output is write-only to the application authority; provider credentials are never saved locally. API keys are entered through pinned Wrangler, using its prompt or inherited protected stdin. Unknown existing model-auth encryption keys are preserved.

The original asset, installed distribution, complete guided setup, Windows ACL, actual Cloudflare and live-provider gates remain open. [Operator details](../../docs/operator-guide.md).
