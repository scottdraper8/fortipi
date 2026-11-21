# Pinned pre-commit tool environment

This is a build-host tool closure, not a change to product dependencies, image inputs or publication licensing policy. Python remains 3.15.2, pre-commit remains 4.7.0, and both external hook repository revisions remain unchanged. Gitleaks and its Go installer are untouched.

`precommit-python.lock.json` records exact public archive URLs, sizes, SHA256, release metadata and retained upstream license hashes for all 17 installed distributions. The two requirements files must agree byte-for-byte with that lock. No version is selected at bootstrap time. Build inputs are pip 26.3, packaging 26.3, setuptools 84.2.1, wheel 0.48.0 and universal Cython 3.3.1. Runtime adds cfgv 3.5.0, identify 2.6.20, nodeenv 1.12.0, PyYAML 6.0.3, virtualenv 21.15.6, distlib 0.4.4, filelock 4.2.10, platformdirs 4.14.5, python-discovery 1.9.5, ruamel.yaml 0.19.1, pre-commit and the fixed hook source.

All marker-active dependencies for CPython 3.15 are present. `identify[license]`, nodeenv's optional extras, ruamel's optional compiled bindings, setuptools' extras, tomli below Python 3.11 and virtualenv's older-Python branches are not requested. The actual installer checks metadata compatibility and `pip check` checks the installed closure. Virtualenv's embedded seed wheels remain upstream data; none of the selected hooks invokes its Python installer.

PyYAML has no cp315 wheel in its 6.0.3 release. Its authenticated sdist is built with the reviewed setuptools/Cython/wheel graph already installed, `--no-build-isolation --check-build-dependencies --require-hashes`, no index, no wheel cache, and no bytecode compilation. A compiler/build prerequisite failure is fatal. Cython's universal wheel needs no additional source build. That wheel omits legal texts: its exact same-release sdist supplies retained Apache-2.0 texts and matches all 128 wheel Python modules byte-for-byte; the sdist is a review-only input, never installed or built.

The published pre-commit-hooks 6.0.0 wheel SHA256 `76161b76d321d2f8ee2a8e0b84c30ee8443e01376121fd1c90851e33e3bd7ee2` has 35 modules: all 33 shared modules match fixed commit `3e8a8703264a2f4a69428a0aa4dcb512790b2c8c`, but it additionally contains `check_byte_order_marker.py` and `fix_encoding_pragma.py`. It is therefore **not installed**. The bootstrap builds the already-pinned source archive SHA256 `8edef13648833ba6a761aa31652adbb385d98e36e3758ed67abf9360c6b47fc8` instead. All 33 installed hook modules must match the source tree digest `af1aab1bc04357add083ca2e0dc71a12f788408452223a87385561eb483aebc6`. This preserves actual pinned source and console entries, rather than silently adopting extra wheel code.

Top-level licenses are MIT, Apache-2.0/BSD and PSF-2.0; exact texts and bundled notices are retained under `licenses/python/`. Pip's vendored certifi includes its upstream MPL-2.0 certificate-bundle terms; this is not relabeled permissive, removed or added to product exceptions. The build-host archives remain upstream works with their original legal material. No such tool environment is put into FortiPi npm packages or images.

`precommit-vendored.json` records 30 bundled component identities in pip/setuptools. Fresh OSV checks of the 17 installed distributions yield no findings. Five alias records for three setuptools issues match pip's old setuptools70.3 vendor marker: they concern `setuptools/package_index.py`, MANIFEST matching in `setuptools/command/egg_info.py`/`_distutils/filelist.py`, and legacy `setuptools/wheel.py`. The hash-locked pip archive contains only `pkg_resources/__init__.py` and its LICENSE, **none of those setuptools implementations**. The actual installed build backend is fixed setuptools84.2.1. Exact pip artifact binding and canonical advisory fingerprints prevent carrying this assessment to changed code or advisories. No full setuptools70.3 installation or general advisory suppression is permitted.

## Usage

Supply the exact interpreter explicitly; it is never selected from ambient PATH. CI uses `setup-python`'s `python-path` output from the existing SHA-pinned action. Local proof used Homebrew's existing Python3.15.2; that is not a claim about Linux/Windows interpreter execution.

```text
node tools/unstale/precommit-python.ts --python /absolute/python3.15 --directory /absolute/new-private-directory
node tools/unstale/precommit-python.ts --python /absolute/python3.15 --verify /absolute/private-directory
node tools/unstale/review-precommit.ts
FORTIPI_PRECOMMIT_TEST_PYTHON=/absolute/python3.15 node --test tools/unstale/precommit-python.test.ts
```

Creation requires a new directory. `--archives /absolute/closed-directory` is an offline input: missing, changed or extra members fail before interpreter execution; it never repairs that directory. Otherwise only locked public URLs are downloaded and all hashes are checked before pip runs. Pip is launched directly from its authenticated wheel inside a venv created with `--without-pip`; neither ambient pip nor ensurepip decides the installer. Its child environment is allowlisted and configuration reads are disabled with `PIP_CONFIG_FILE=os.devnull`. `HOME` is neither set nor repurposed.

The bootstrap verifies installed distribution identities, `pip check`, source module bytes and private console commands, freezes the venv, and records its complete tree plus bootstrap executable hash. `--verify` rechecks that identity before use. `--github-path` appends only the verified executable directory to the existing runner path file. Set `PRE_COMMIT_HOME` to the returned private location when running hooks. Existing shared developer Git hook launchers are not rewritten by this task.

## Primary references

- [PyPI release metadata](https://pypi.org/pypi/pre-commit/4.7.0/json); every package's exact version endpoint is checked by `review-precommit.ts`.
- [Fixed hook source](https://github.com/pre-commit/pre-commit-hooks/tree/3e8a8703264a2f4a69428a0aa4dcb512790b2c8c).
- [Hash-checking requirements](https://pip.pypa.io/en/stable/topics/secure-installs/), [build isolation and dependency checks](https://pip.pypa.io/en/stable/reference/build-system/).
- [Upstream system/unsupported hook semantics](https://pre-commit.com/#unsupported).
- Setuptools advisories: [download traversal](https://github.com/pypa/setuptools/security/advisories/GHSA-5rjg-fvgr-3xxf), [manifest normalization](https://github.com/pypa/setuptools/security/advisories/GHSA-h35f-9h28-mq5c), [legacy wheel path escape](https://github.com/pypa/setuptools/security/advisories/GHSA-xmj3-9gf7-h52w).
