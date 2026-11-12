# Operator guide

The CLI validates the public contract, protects local application identities and
packages genuine Worker assets with their contracts, templates and original
notices. Actual installed offline dry-build, native Windows
protection and deployed verification remain acceptance gates; local artifact checks
do not establish those outcomes.

The operator file is exactly `{schemaVersion:1,deployment:{name,origin,accountId?},runtime:<Configuration>}`. Origin is a canonical HTTPS origin; account ID is an optional non-secret selection. Unknown fields are rejected. Only `runtime` becomes `vars.FORTIPI_CONFIG`; no credentials or local paths belong there. The [example](../packages/fortipi-cli/templates/operator-config.example.json) validates against the generated schema. Select Computer or explicit local workspace independently of native, cloud-JS or Linux execution. A missing local device remains a remote waiting condition. Local validation checks canonical capability declarations, not account entitlement or freshness that the contract does not establish.

Provider selections use `auth:{kind:"secretRef",secretRef:"PROVIDER_SECRET"}` for API keys, or `auth:{kind:"oauth",providerId:"openai"}` for OAuth. Workers AI uses the AI binding. OpenAI Codex is a distinct OAuth-only provider. Custom gateways require a reviewed credential-routing contract. Model usage budgets are not infrastructure policy.

With the packaged assets, the deployment interface is:

```sh
fortipi login
fortipi prepare --config operator.json --directory NEW_DIRECTORY --json
# For an upgrade, preserve the prior prepared declaration history:
fortipi prepare --config operator.json --directory NEXT_DIRECTORY --previous-directory NEW_DIRECTORY --json
fortipi deploy --directory NEW_DIRECTORY --dry-run --non-interactive --json
fortipi deploy --directory NEW_DIRECTORY --profile production --bootstrap local --json
```

Preparation is exclusive and verifies asset closure/hashes and canonical configuration before creating its output. Dry-run generates/uploads no credentials and returns a build result, not a deployment receipt. Deployment rechecks prepared bytes and configuration, uses pinned Wrangler, then checks public health. A successful version receipt is not a rollout deployment ID. Secret upload or later auth-key setup invalidates earlier rollout evidence; release tooling must verify the final deployed state.

Use `--previous-directory` for an existing prepared installation. The previous
manifest, configuration and exact deployment identity must match their receipt.
Known paid capability removal or migration loss/reordering fails with an explicit
repair requirement. This preserves the prior declaration; release tooling must
still reconcile the actual applied remote migration history. A fresh Free/native
configuration has neither Loader nor Containers. Linux preparation requires the
actual reviewed image manifest digest and context; its config ID is not a pullable
registry identity. Preparing a paid variant does not purchase or prove entitlement.

Customer bootstrap is persisted in `~/.fortipi/PROFILE.json` before upload. Named CLI profiles are exact-origin application credentials, protected outside Git checkouts: POSIX directories 0700/files 0600, or restrictive current-user Windows ACLs. Link, hardlink, ownership, overwrite and parent checks fail closed. Never copy deployment credentials into an application profile. Lost setup replies reuse the protected identity; revocation remains authoritative.

`fortipi init --config operator.json` asks independently about model/provider
authentication, workspace storage, execution and routing, then confirms the
validated configuration before exclusive creation. `--from` copies an existing
canonical config and supports `--non-interactive`. Native execution keeps the
conservative Free policy. Selecting a paid backend requires your existing explicit
policy and backend config; initialization does not verify entitlement or upgrade
an account.

`fortipi setup --config operator.json --directory prepared --profile production`
initializes a missing config, confirms your first workspace/agent and exact grant
scope, then composes login, prepare, local-bootstrap deployment, provider readiness
and resource/credential creation. API-key values go through Wrangler's own input;
OAuth uses the existing Pi flow. Existing unknown binding secrets and model-auth
keys are preserved. The recipient profile is separate from the administrator.
Neither a client role nor a native target choice silently grants shell access.

Setup saves its non-secret plan, stable request IDs and observed receipts under
`~/.fortipi/DEPLOYMENT/setup-PROFILE.json`, alongside protected per-operation input
files. Tokens remain only in their protected identity/profile files. Repeat the
same command to continue acknowledged steps or check fresh readiness. A missing
device/root binding or model reports `setup-pending`; a lost mutation reply reports
`setup-uncertain` and its saved request ID. It never replays an unresolved effect.
Use `status`, the saved input with the corresponding public management command,
and authority receipts to reconcile first. Credential delivery failure requires
receipt/revoke/replace recovery, never another blind mint. The contract has no
plaintext-token or arbitrary request-ID lookup endpoint. After a killed process,
the setup lock remains: verify no setup process is running before removing only
that deployment/profile's `.lock` file. Keep its journal, inputs and identity.
Changing a bound config, asset version or output directory requires explicit
repair rather than a silent new setup. Fresh noninteractive setup needs prior
confirmed choices; missing choices fail before account effects. Setup completion
is an observation, not final rollout, model-call or live durability evidence.

Trusted CI retains the exact interface:

```sh
fortipi prepare --config NON_SECRET_CONFIG --directory EMPTY_DIRECTORY --json
fortipi deploy --directory PREPARED_DIRECTORY --bootstrap existing --non-interactive --json
```

Existing mode consumes its explicitly supplied `FORTIPI_ADMIN_TOKEN` through Wrangler stdin, without replacing it, persisting it or forwarding it through argv/child environment. Wrangler owns Cloudflare authentication. FortiPi does not read its auth files or GitHub secrets.

For external API keys, select a binding first, then use `models configure --config operator.json --provider PROVIDER --auth binding --secret-ref NAME --directory PREPARED_DIRECTORY`. Wrangler prompts on the terminal; `--secret-stdin` instead gives Wrangler inherited stdin from the operator's protected source. Do not put keys in command arguments, JSON input, shell history or config. For OAuth use `models login --provider PROVIDER --directory PREPARED_DIRECTORY --profile production --request-id STABLE_ID`. Supported interactive methods belong to pinned Pi: OpenAI callback/manual full URL; Anthropic browser/copy code; Codex browser/device code. Noninteractive OAuth fails. Complete credentials, including OpenAI client ID/scopes or Codex account binding, are sent once through TLS and discarded. No local provider-auth cache is created.

`FORTIPI_MODEL_AUTH_KEY` is separate random key material. Login checks secret names, preserves an unknown existing server key, and persists a newly generated local key before stdin upload. It reuses that same key after an interrupted upload. Missing/mismatched keys require repair; prepare, status and dry-run never provision keys.

Administration uses `--input NON_SECRET_DTO.json`, stable request IDs and explicit expected versions/generations. `config apply` requires both the canonical `ConfigurationPatch` input and matching `--expected-version`. `agents configure` takes `--id`; `workspaces bind` creates a binding or, with `--id`, uses canonical rebind. Executor registration/root bindings are explicit; the contract has no standalone executor-bind operation.

`credentials create|rotate --input PATH --output PROTECTED_PATH` writes one-time material directly to its reserved destination. Rotation also reports the old credential's pending/complete revocation. If delivery fails, use the saved request/credential metadata to query/revoke/replace; plaintext recovery is unavailable. No automatic mutation retry occurs. `credentials revoke` and `executors revoke` require canonical `RevocationInput`; `export status --id OPERATION_ID` observes durable operation state. App-admin grants do not imply conversation, workspace-read or shell authority.

Exports require explicit resource grants. `export create|backup --input PATH` returns an operation; inspect its state before `export download --id OPERATION_ID --output PROTECTED_PATH --max-bytes N`, adding `--artifact-id` when needed. Downloads verify exact length/hash and clear failed output. An unavailable local scope is reported by the authority and is not silently included.

`fortipi tui --profile CLIENT_PROFILE -- ...` launches the separately installed TUI with only its own client profile and an allowlisted environment. Configure that profile using the [TUI instructions](../packages/fortipi-tui/README.md). No implicit client/executor installation or privilege inheritance occurs.
