# Image source and notices

Ship `sources-and-notices.tar` with each image distribution and preserve its SHA-256
from `image-metadata.json`. Release packaging must provide equivalent access to
this exact kit alongside the image and maintain that access. A developer cache or
an expiring CI artifact does not satisfy this delivery requirement.

The kit contains the exact Debian source archives, `.dsc` descriptions and Debian
patch/build files for the final installed packages and their recorded `Built-Using` and
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
The recipe also includes `image-archive.ts`, `image-prune.ts` and `rootfs.ts`, which hash the actual saved OCI
manifest, config and layers. The saved manifest identity is distinct from an
exporter config identity and from any future published registry manifest.

Use a fresh checkout of the recorded commit from the published FortiPi repository
(`https://github.com/scottdraper8/fortipi`), preserving its Git identity. Compare
the supplied source archive and recipe/metadata hashes before building. The release
must publish that exact commit before distributing the kit. With the recorded
Node26.13.0 and pnpm12.18.0 first on PATH, run `node scripts/install-dependencies.ts`
at its root. This installs the exact reviewed `tar` dependency through the frozen
lock; do not install a floating package or copy a dependency tree. The source
snapshot supplies all installer/configuration inputs. Host `git`, `tar`, `ar`, `xz`,
`gpgv`, and GNU or LLVM `objdump` with amd64 ELF support are required; the recorded
Docker/Buildx provisioner is required for image builds. These host tools are not
installed into the runtime image. Signature verification uses a fresh temporary
home and explicit public keyrings, without consulting personal GnuPG state.
Run `node apps/worker/container/build.ts --prepare` to verify/reconstruct the kit,
or `--verify` for the offline image and runtime fixture. Generated image recipes
must match their recorded commit; construction-only kits mark mismatches and are
not distributable images. No model/deployment credentials are needed in this flow.

The final runtime contains **79 packages / 56 source identities / 182 source
payloads**, including the retained libapt-pkg7.0 library and its apt source.
`debian-freeze.json.inputInstalled` separately records all78 packages of the
original immutable Debian input. It is provenance, not a statement that every
input package or binary is conveyed in the final image. The intermediate stage
offline-installs the exact frozen additions and normally purges only apt and sqv.
The final stage starts FROM scratch and copies the cleaned rootfs; deleting in a
later inherited layer would leave the original executable bytes distributed.
No autoremove, package-manager force option, floating installer or dependency
upgrade is used. The image supplies shell/Computer/FUSE execution; scripts that
require apt or sqv must use a separately reviewed image rebuild and deployment.
Runtime package installation through apt is not provided.

The final image explicitly sets PATH, PORT, MOUNT_POINT, FUSE_MOUNT, root uid/gid,
workdir, entrypoint, empty default command, default shell, exposed port and stop
signal. These restore the prior required behavior instead of inheriting defaults
from scratch. Image verification compares actual configuration, exact package and
source inventories, and the cleaned versus final filesystem: retained bytes,
numeric owners, modes/setuid, symlink and hardlink groups, raw PAX xattrs including
capabilities. It requires the configured fusermount3 root ownership and4755 mode;
effective privileges and a working mount still need the supported runtime proof.

Every final saved layer is inspected before whiteout merging. All25 removed
executable paths, aliases and19 original ELF hashes are forbidden, including
renamed copies. Original Debian binary-bearing layer digests/DiffIDs and any
unreferenced conveyed blob/file are rejected. Known Docker compatibility aliases
must match verified image layers/config. The source kit has an explicit member
inventory; its Git source archive and direct members are scanned for original
runtime binary/layer bytes. It ships no base/intermediate image archive or build
cache. Public input identities/references remain in the source provenance.
The ignored cleaned-stage image/archive is verification-only and must not be
included in release packaging. Final-image absence, source delivery and rights
remain subject to independent artifact review.

The FUSE3 runtime and library are Debian amd64 **3.18.3-1**, selected only from the
signed SID indexes at `20261110T000000Z`. All other dependencies retain the frozen
Trixie/base identities. Their actual controls require libc6 >=2.38 and the existing
mount package; the base supplies libc6 2.41. The previous adduser dependency is no
longer selected. No development package is installed. The separately installed
libfuse2t64 2.9.9-9 is not covered by the FUSE3 security comparison.

`fuse-security.ts` authenticates both dated InRelease files and their exact index
hashes. Its archive trust bootstrap is the exact public keyring extracted from the
hash-verified Debian base layer, with an independently pinned keyring hash and
Debian13 archive fingerprint. The FUSE DSC signature uses the exact public key
response from Debian's keyring service and its full signing/primary fingerprints.
The original tarball's upstream signify Ed25519 signature is verified with the
key from official tag `3dbcfce64ba0dd529cec7b94305662e7901a991b`;
four mount/session source files must equal that reviewed tag's bytes. No local
backport or vendor patch is used. `security/` ships those signatures, public keys,
authenticated indexes and verification identities with the source kit. This
reconstructs a dated snapshot, including after its Valid-Until date; it does not
substitute for a fresh security/release review.

`elf-compatibility.ts` compares actual package controls to their signed-index
records, checks SONAME/needed libraries, and resolves the actual embedded addon's
symbols against the new library, base libc and source-matched computerd exports.
It also checks the new library/helper's required symbols against the frozen libc.
`native-compatibility.json` binds those exact ELF bytes and versioned requirements.
Static symbol resolution does not prove structure layouts, installation, helper
effective privileges, the Linux dynamic loader or a FUSE mount. The offline
Docker build and actual supported Linux/FUSE checks remain required.

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
independent review and actual interface-compatible shared-library replacement is
demonstrated through computerd/FUSE. Removing the unused sqv static-Rust consumer
avoids its static relink burden only when the actual final distributed blobs and
source kit pass the absence checks. It is not a blanket licensing or security
approval, and the earlier unpruned image cannot inherit that claim. Publish the actual registry
manifest digest separately from the local image ID and input digests. Source and
license evidence does not certify vulnerability status or runtime/FUSE behavior.
