# Image source and notices

Ship `sources-and-notices.tar` with each image distribution and preserve its SHA-256
from `image-metadata.json`. Release packaging must provide equivalent access to
this exact kit alongside the image and maintain that access. A developer cache or
an expiring CI artifact does not satisfy this delivery requirement.

The kit contains the exact Debian source archives, `.dsc` descriptions and Debian
patch/build files for the installed packages and their recorded `Built-Using` and
`Static-Built-Using` dependencies. Extract each source using its `.dsc` with
`dpkg-source -x`, and use its Debian build/install instructions in a compatible
build environment. Epochs, source versions and binary rebuild versions remain
distinct in `debian-freeze.json`. `source-names.json` maps every descriptor and its
canonical sibling filename to exact SHA256/size. All descriptor-referenced siblings
are checked and shipped together, including historical snapshot content-addressed
inputs. `source-kit-inventory.json` binds the shipped archive bytes. Sources
already compressed upstream remain unchanged.

For the FortiPi recipe, `fortipi-source.tar` contains the complete tracked source
snapshot, including root/package manifests, frozen pnpm lock/workspace layout,
installer scripts and exact platform-tool metadata. `source-revision.json` binds
its archive hash, Git commit, Node/pnpm/tar versions, root manifest/lock and platform
metadata. `source-kit-recipe/` additionally carries the image recipe and metadata
for independent comparison, including `debian.ts`.
The recipe also includes `image-archive.ts`, which hashes the actual saved OCI
manifest, config and layers. The saved manifest identity is distinct from an
exporter config identity and from any future published registry manifest.

Use a fresh checkout of the recorded commit from the published FortiPi repository
(`https://github.com/scottdraper8/fortipi`), preserving its Git identity. Compare
the supplied source archive and recipe/metadata hashes before building. The release
must publish that exact commit before distributing the kit. With the recorded
Node26.13.0 and pnpm12.18.0 first on PATH, run `node scripts/install-dependencies.ts`
at its root. This installs the exact reviewed `tar` dependency through the frozen
lock; do not install a floating package or copy a dependency tree. The source
snapshot supplies all installer/configuration inputs. Host `git`, `tar`, and `xz`
are required; the recorded Docker/Buildx provisioner is required for image builds.
Run `node apps/worker/container/build.ts --prepare` to verify/reconstruct the kit,
or `--verify` for the offline image and runtime fixture. Generated image recipes
must match their recorded commit; construction-only kits mark mismatches and are
not distributable images. No model/deployment credentials are needed in this flow.

The complete Computer source archive includes its modified vendored native addon,
upstream provenance and patch descriptions. The kit also carries the exact embedded
npm source archives, original notices, full Node aggregate license and image build
recipe. The embedded inventory records source identities and observed executable
assets. It does not attest a reproducible upstream native build.

FortiPi's Sustainable Use License covers FortiPi-owned code. It does not replace
or restrict the separate third-party licenses, source access, modification,
replacement or debugging rights in these notices. Preserve all applicable
copyright notices, GPL/LGPL texts, GCC exceptions and other component terms.

Release remains blocked until the final image inventory and source kit receive
independent review, including the static LGPL rebuild/relink mechanism and actual
interface-compatible shared-library replacement. Publish the actual registry
manifest digest separately from the local image ID and input digests. Source and
license evidence does not certify vulnerability status or runtime/FUSE behavior.
