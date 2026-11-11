# One-time release and deployment access

GitHub repository: https://github.com/scottdraper8/fortipi
User enters credentials directly into the GitHub environments below. Agents inspect names and masked workflow outcomes only.

## Cloudflare
Production environment: https://github.com/scottdraper8/fortipi/settings/environments
Select production and add secrets:
- CLOUDFLARE_ACCOUNT_ID: target account's 32-character ID.
- CLOUDFLARE_API_TOKEN: custom account-scoped token.

Restrict the token to the one target account. For the initial deployment, grant **Admin at the Workers product scope** in that account. Cloudflare's current roles require product-level Admin to create a new Worker; Editor and per-Worker grants apply to existing Workers. After bootstrap, a replacement token can use Editor scoped to the deployed FortiPi Worker for updates, secrets and observability; keep product-level Admin only for operations that actually create additional Workers. Durable Objects inherit the implementing Worker's role and do not need a separate role.

Additional account permissions:
- Account Settings: Read
- Workers AI: Edit (model discovery/testing and optional direct API use)
- Containers: Edit (when deploying/testing the cloud Linux execution backend)

Older permission lists may still show Workers Scripts Edit and Workers Tail Read. Use the current Workers roles above rather than assuming an older edit permission proves first-deployment authority. Read-only access checks cannot establish creation rights; the actual deployment must do that.

No zone permissions are needed for the initial workers.dev origin.
The initial Computer workspace uses Durable Object storage and requires neither R2 activation nor R2 permissions. Both Dynamic Workers/Loader (cloud JavaScript execution) and native Containers require Workers Paid. Free/unknown configurations omit unavailable paid bindings; full cloud execution acceptance needs existing paid entitlements. Do not change subscription plans without an explicit user decision.
Workers AI uses a binding at runtime; no third-party model key is required for the first live smoke test.
External model-provider credentials remain configurable server-side; request one only if the user chooses that provider.

The parent provisioned `production` secret `FORTIPI_ADMIN_TOKEN` using random material piped directly into encrypted GitHub secret storage, without displaying or writing its value to disk. Preserve it across deployments. Trusted deployment uploads it through Wrangler stdin; trusted live tests mint temporary scoped client/executor credentials through the public application API and revoke them afterward. No additional static client/executor GitHub secrets are needed, and ordinary Actions tokens do not administer secrets.

Primary references:
https://developers.cloudflare.com/fundamentals/api/reference/permissions/
https://developers.cloudflare.com/workers/authorization/workers/
https://developers.cloudflare.com/workers/authorization/durable-objects/
https://developers.cloudflare.com/agents/harnesses/pi/
https://developers.cloudflare.com/containers/
https://developers.cloudflare.com/dynamic-workers/pricing/

## npm
Release environment: https://github.com/scottdraper8/fortipi/settings/environments
Select npm-release:
- Secret NPM_TOKEN: granular token with Packages/scopes Read and write (publish and stage), Only select packages and scopes, select the chosen scope, Bypass two-factor authentication checked, Organizations No access, expiration seven days. Select the namespace rather than only existing packages so new packages can be created. Complete npm token-creation authentication in the browser.
- Variable NPM_SCOPE: npm username or owned organization, without @. Prefer existing owned scope; @fortipi only if controlled.

Use npm for CLI, official TUI, client SDK, separate local executor, and shared public contracts as needed.
Use GitHub Releases for versioned tarballs, checksums, notices and SBOM. Homebrew/curl installers add release surfaces without sufficient v0.1 benefit.
Use the scoped bootstrap token for the initial release, because npm requires an existing package and interactive 2FA to configure trusted publication. Future OIDC configuration must match scottdraper8/fortipi, release.yml, environment npm-release, and direct publish permission. Register trust only when a successful OIDC release will occur within 48 hours. Bypass tokens cannot modify trust settings; direct bypass-token publishing is scheduled to end January 2027. Do not claim OIDC configured until verified.

References: https://docs.npmjs.com/creating-and-viewing-access-tokens/ ; https://docs.npmjs.com/cli/v12/commands/npm-trust/ ; https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/

## Verification
Run Access preflight after secret names are present. It checks account/Workers/model-catalog access and npm authentication with a syntactically valid scope.
Read checks do not prove deploy or publish permission; deployment and publication are separate required evidence.
No custom secret-input helper, local env file, credential values in logs or source-controlled secrets.
