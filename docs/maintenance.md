# Compatibility maintenance

The standalone **Compatibility review** workflow runs a weekly public, read-only
check plus `workflow_dispatch` and checks on pull requests changing this guard. Integration into the default branch activates the
schedule. It uses Node builtins and `contents: read`; no Cloudflare account, npm or
model credentials are needed. It writes an Actions summary and a small JSON report
to the job log (normal repository log retention); it creates no issues, comments,
messages, update PRs or artifacts. There is no product startup polling.

Run from the repository root with the pinned Node toolchain:

```sh
node tools/compatibility-watch/watch.ts
# Optional local public reads using existing gh authentication, without exposing tokens:
node tools/compatibility-watch/watch.ts --gh
node --test tools/compatibility-watch/watch.test.ts
```

`catalog.ts` limits the check to official Cloudflare policy/compatibility sources,
Computer/computerd, upstream libfuse and Meson, Agents PiHarness/Lifecycle, the Pi package family, Wrangler,
workerd, Node, pnpm, TypeScript's original compiler release repository and node-pty. Policy watches include shared pricing
partials and compatibility flag data. GitHub Contents identities include recursive
directory tree hashes. Pi watches the used package family and shared runtime sources;
unrelated coding-agent guides and evals are outside this product's dependency scope.
Each repository ref resolves once per run; all its paths
are read at that commit. Release tags resolve to actual commits, including annotated tags;
retargeting a tag requires review. Latest published stable releases are pointers, potentially
from a different major; default-branch package versions can be unreleased.
Neither versions nor semver labels establish breaking changes or safety.

Requests are GET-only to `api.github.com`, without redirects or retries: at most
64 requests, three concurrent sources, 10 seconds per request, 90 seconds total and
512 KiB per response. Empty, malformed, missing or potentially truncated responses
cannot turn green. GitHub rate limits/outages fail explicitly. The separate
workflow retains existing Action/version pins and StepSecurity block egress;
allowed hosts serve GitHub public reads/checkout, Node setup, StepSecurity,
PyPI metadata and OSV advisories.

Before checking upstream identities, the workflow reviews the exact Python
build/runtime inputs used by pre-commit. Changed artifact metadata or advisory
fingerprints stop the check. The shared canonical JSON implementation also runs
from a cold checkout, without installing packages or emitting the contract.
See [the pinned tool review](../tools/unstale/precommit-python-review.md) for its
archive, license, bundled-component assessment and private bootstrap commands.

Dependabot discovers the hashed Python inputs through
`tools/unstale/requirements.txt`; its version-update PR limit remains zero, so
only security updates can create PRs. Proposed changes still require the matching
lock, archive and license review. Installation uses the TypeScript bootstrap and
its verified private environment; the discovery file is not a second installer.

| Outcome                                           | Meaning and action                                                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unchanged` (exit 0 only if every source matches) | Matches a deliberately reviewed reference and its local pins. No full compatibility claim.                                                                 |
| `review-required` (exit 1)                        | Upstream content/release identity or a local pin changed. Inspect source, commit/diff and release-note links. Classification stays unknown until reviewed. |
| `check-unavailable` / `unknown` (exit 2)          | Access/timeout/HTTP failure, unfamiliar response, incomplete baseline or unreviewed catalog. Restore observation/review; never report an all-clear.        |

For each changed entry:

1. Read the linked primary diff/changelog. Review Cloudflare Free limits, reset and
   exhaustion semantics, pricing and paid capability gates against infrastructure
   bounds. Account-wide usage remains unknown. Review dependency API exports/hooks,
   task recovery/cancellation/replay, SQLite behavior, provider auth, native ABI and
   Computer/FUSE protocol/daemon changes relevant to the pinned FortiPi version.
2. Classify relevance using the actual diff. A documentation-only or unreleased
   change may be acknowledged with a precise reason for retaining the current pin.
   If adoption is needed, deliberately change exact pins/locks through the existing
   supply-chain review and validate with meaningful runtime/recovery, native/FUSE
   and installed-consumer tests plus license/notices, SBOM and security checks.
   Existing unstale and security-only Dependabot remain the security authority;
   ordinary upstream releases do not create version-bump PRs.
3. Update **only individually reviewed** entries in `baseline.json` in a reviewed
   commit: copy the report's observed snapshot and pins, retain/verify the catalog
   SHA-256 (`hash(source)` in `watch.ts`), and supply `reviewedAt` and a concise
   `reviewNote` describing evidence, disposition and remaining limits. Review the
   diff and rerun. There is intentionally no accept-all or automatic update command.
   A failed observation is never a usable baseline. Catalog changes require review
   too. Store hashes/identities and original short notes, not third-party articles.

The initial 2026-11-11 baseline records reviewed **reference identities and review
scope**, not a claim that all upstream APIs or future releases are compatible.
Its notes preserve material plan/experimental API caveats. Directory watches can
flag irrelevant edits; published pages may lag their official source repository,
and changes outside this small catalog remain possible.

The upstream libfuse release watch is separate from Computer's vendored native addon.
It tracks the existing canonical FUSE 3 pins in `tools/unstale/platform-tools.json`.
Before an image release, verify those pins match its exact Debian freeze and review
distro patches against relevant upstream fixes. The initial upstream reference
does not establish security or compatibility of the packaged native library.

Meson's release watch tracks the build tool's exact version, source commit, archive
and COPYING hashes in `tools/unstale/platform-tools.json`. Its latest-release
snapshot is a review pointer; it does not renew runtime or security acceptance.
Review build-option/API changes and Python requirements before adoption, retaining
the pinned entrypoint/license checks and private interpreter executable, prefix,
import and mapped-library verification. Validate the actual FUSE shared-library
and static-helper rebuild, replacement/relink and I/O through the existing process.
Update only the reviewed Meson baseline entry; other reference records retain their
original evidence and timestamps. Security-only Dependabot remains separate.

Release tooling (thread 9) must run this check at preflight on the candidate SHA
and inspect relevant unreviewed drift before deployment/publication. Attach the
result identity/time to release evidence. Exit 1/2 needs an explicit primary-source
review/disposition or repaired observation and rerun; never silently waive a
failure or blindly replace the baseline. This standalone guard does not modify
the release workflow or replace its pinned-lock, runtime, security or license gates.
