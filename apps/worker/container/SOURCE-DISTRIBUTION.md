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
distinct in `debian-freeze.json`. `source-kit-inventory.json` binds the shipped
archive bytes. Sources already compressed upstream remain unchanged.

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
