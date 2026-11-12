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
Node26.13.1 and pnpm12.18.0 first on PATH, run `node scripts/install-dependencies.ts`
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

For a newly reviewed Computer/Node identity, `--prepare-inputs` authenticates and
reconstructs source material without claiming an executable exists. On trusted
Linux x64, `--freeze-embedded` then compiles the exact Computer0.11.1 source through
the upstream esbuild recipe/bootstrap/addon shim and creates a SEA blob with the
actual signed Node22.23.5 target. Only build-script entry/export mapping and
diagnostic metadata are adapted; the complete adapter and original source ship.
The same target Node runs exact postject1.0.0-alpha.6 with commander9.5.0, extracted
from reviewed SRI archives without lifecycle scripts. They are isolated build
tools, not image/runtime dependencies. The old image contributes only its
unchanged source-bound FUSE addon; the Dockerfile copies the newly built SEA.
Review and commit the resulting actual embedded freeze before final prepare/build.
Missing outputs remain an explicit failed gate, never a metadata-only upgrade.
The kit includes the signed Node runtime/source identities and archives, complete
Node aggregate license, actual build/input receipt and both effective authenticated
zlib patches. A fresh Linux prepare rebuilds and checks the actual frozen SEA;
other hosts must receive that matching public binary/receipt handoff. Final image
inventory, FUSE, egress and recipient modified-library/static-helper proofs must
be repeated at the new identity. AD results do not transfer to these bytes.

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
signed SID indexes at `20261110T000000Z`. The sole additional security overlay is
zlib1g and corresponding source at `1:1.3.dfsg+really1.3.1-1+deb13u1`, bound to the
supplied signed trixie-security InRelease and immutable by-hash indexes. All other
dependencies retain the frozen Trixie/base identities. The FUSE controls require libc6 >=2.38 and the existing
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
For the LGPL combined work, recipients may modify the work for their own use
and reverse engineer it to debug those modifications. FortiPi's terms do not
restrict those permissions. See the shipped FUSE `LGPL2.txt`, especially
[sections4 and6](https://github.com/libfuse/libfuse/blob/3dbcfce64ba0dd529cec7b94305662e7901a991b/LGPL2.txt).

Concrete recipient checks use the complete committed checkout described above.
Set `KIT` to the delivered `sources-and-notices.tar`, `IMAGE` to its canonical
saved OCI archive, `META` to `image-metadata.json`, and `RECORDS` to the directory
containing `installed-source-inventory.json` and `license-inventory.json`.
Obtain `KIT_SHA`, `META_SHA` and `COMMIT` from independently authenticated release
metadata; deriving expected hashes from an untrusted download authenticates nothing.
Run the artifact gate with a new receipt path:

```sh
node scripts/image-source-distribution.ts \
  --kit "$KIT" --kit-sha256 "$KIT_SHA" --commit "$COMMIT" \
  --image "$IMAGE" --metadata "$META" --metadata-sha256 "$META_SHA" \
  --records "$RECORDS" --out artifact-source-check.json
```

This rechecks actual tar members, Git archive/recipe bytes, every DSC sibling and
final-package source dependency, original notices, dated Debian signatures and
upstream FUSE signature. It reads the final image layers to check package status,
native ELF hashes, notices and pruning. Its receipt explicitly leaves replacement
and durable delivery unverified. A source hash for an old input cannot certify
absence from the final distribution.

The actual addon needs `libfuse3.so.4` dynamically, including
`_fuse_new_31@FUSE_3.17`. Preserve that SONAME and the versioned imports when
substituting a compatible library; recompiling the SEA/addon is unnecessary for
this boundary. The retained `fusermount3` helper separately compiles
`mount_util.c`, `fuse_log.c` and `util.c` into its executable, as shown by its
[upstream Meson target](https://github.com/libfuse/libfuse/blob/3dbcfce64ba0dd529cec7b94305662e7901a991b/util/meson.build).
Its complete source/build inputs are in the same FUSE DSC closure; rebuild that
target rather than relying on shared-library substitution for its embedded code.
This finding is scoped to FUSE and does not certify every image component.

On an actual supported Linux amd64 runner, after the existing independent
recipient import, provision the pinned Meson with the existing Python3.15.2:

```sh
node tools/unstale/provision-meson.ts --python /absolute/path/to/python3.15
```

Prepend the emitted `bin` path to PATH. CI exports this private path automatically.
The replacement gate rechecks the authenticated source tree and Python identity
before use. Inside the existing verified rootless namespace, run:

```sh
node apps/worker/container/library-replacement.ts \
  --kit "$KIT" --kit-sha256 "$KIT_SHA" --commit "$COMMIT" \
  --image "$IMAGE" --metadata "$META" --metadata-sha256 "$META_SHA" \
  --records "$RECORDS" --out NEW_REPLACEMENT_DIRECTORY --require-fuse
```

The runner must already provide `cc`, Ninja, Linux development headers,
`pkg-config`, `dpkg-source` and the reviewed Docker/BuildKit. The gate uses the
repository's exact Meson1.12.1 source and bootstrap Python. It installs no runtime
packages and disables Meson downloads. It extracts the exact DSC, changes
`fuse_pkgversion()` without changing its signature/result, and rebuilds both the
shared library and helper. It also modifies the LGPL `mount_util.c` compiled
into the helper; standalone helper execution must produce that modification's
nonce, while the original helper must not. The helper's only needed shared
library must remain libc, so this separately demonstrates static relinking.
Inspect `modified-fuse/`, `modification.json`,
`meson-build/compile_commands.json` and `library-replacement.json` in that new
directory. To try another compatible change, edit that source tree and repeat
the recorded Meson setup/compile commands, then replace the generated context's
library/helper and rebuild its Dockerfile with the same offline flags.

The automatic original loader calls `fuse_native_runtime_info()`, which calls
`fuse_pkgversion()`; the gate never calls the witness manually. Both baseline and
modified fixtures must mount real FUSE and synchronize read/write bytes. The
modified process must map the rebuilt library, call its nonce-bearing code and
retain the exact original computerd/addon. The unchanged baseline must lack that
witness. Missing-export and mismatched-receipt controls also fail closed.
The helper is rebuilt from its full source and used in the modified fixture.

Rootless execution must retain the existing recipient wrapper's verified user,
network and mount namespaces and `--require-fuse`; launching it on the outer host
does not qualify. `node tools/unstale/run-container-probe.ts --rootless --verify-library-replacement`
invokes it after the existing harness closes, in the same verified context.
macOS/other architectures fail explicitly.
After Linux execution, repeat the artifact gate with
`--replacement NEW_REPLACEMENT_DIRECTORY/library-replacement.json` and
`--replacement-sha256 AUTHENTICATED_RECEIPT_SHA` to bind the runtime result to the
exact image/kit. Producer identity and delivery/retention remain release gates;
these local receipts cannot establish publication or durable source access.

Release remains blocked until the final image inventory and source kit receive
independent review and actual interface-compatible shared-library replacement is
demonstrated through computerd/FUSE. Removing the unused sqv static-Rust consumer
avoids its static relink burden only when the actual final distributed blobs and
source kit pass the absence checks. It is not a blanket licensing or security
approval, and the earlier unpruned image cannot inherit that claim. Publish the actual registry
manifest digest separately from the local image ID and input digests. Source and
license evidence does not certify vulnerability status or runtime/FUSE behavior.
