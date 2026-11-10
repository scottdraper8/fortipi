# One-time release and deployment access

GitHub repository: https://github.com/scottdraper8/fortipi
User enters credentials directly into the GitHub environments below. Agents inspect names and masked workflow outcomes only.

## Cloudflare
Production environment: https://github.com/scottdraper8/fortipi/settings/environments
Select production and add secrets:
- CLOUDFLARE_ACCOUNT_ID: target account's 32-character ID.
- CLOUDFLARE_API_TOKEN: custom account-scoped token.

Restrict the token to the one target account. Account permissions:
- Account Settings: Read
- Workers Scripts: Edit (Worker deployment, bindings, Durable Object migrations and secrets)
- Workers R2 Storage: Edit (workspace snapshots/artifacts)
- Workers Tail: Read (deployment diagnosis)
- Workers AI: Edit (model discovery/testing and optional direct API use)
- Containers: Edit (optional native Linux executor deployment/testing)

No zone permissions are needed for the initial workers.dev origin.
The target account must have R2 activated; native Containers require Workers Paid. Use existing entitlements; do not change subscription plans without an explicit user decision.
Workers AI uses a binding at runtime; no third-party model key is required for the first live smoke test.
External model-provider credentials remain configurable server-side; request one only if the user chooses that provider.

Primary references:
https://developers.cloudflare.com/fundamentals/api/reference/permissions/
https://developers.cloudflare.com/agents/harnesses/pi/
https://developers.cloudflare.com/containers/

## npm
Release environment: https://github.com/scottdraper8/fortipi/settings/environments
Select npm-release:
- Secret NPM_TOKEN: granular token scoped to publication under the chosen npm user/org namespace. Exact UI/first-publish instructions pending npm investigation.
- Variable NPM_SCOPE: npm username or owned organization, without @. Prefer existing owned scope; @fortipi only if controlled.

Use npm for CLI, official TUI, client SDK, separate local executor, and shared public contracts as needed.
Use GitHub Releases for versioned tarballs, checksums, notices and SBOM. Homebrew/curl installers add release surfaces without sufficient v0.1 benefit.
Prefer GitHub OIDC for continuing npm publication. Initial publication and trust configuration requirements must be verified before launch.

## Verification
Run Access preflight after secret names are present. It checks account/Workers/R2/model-catalog access and npm authentication/scope membership.
Read checks do not prove deploy or publish permission; deployment and publication are separate required evidence.
No custom secret-input helper, local env file, credential values in logs or source-controlled secrets.
