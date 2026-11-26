import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDryCliErrorCode,
  distributionInstallFailureLine,
  distributionInstallPhaseLine,
  distributionInventoryFailureLine,
  nativeEvidenceFailureLine,
} from "./native-evidence-observation.ts";

const canary = "private-role-ticket-request-path-canary";
test("native failure diagnostics retain fixed checkpoints and bounded error class/code only", () => {
  const error = new assert.AssertionError({
    message: canary,
    actual: { token: canary },
    expected: canary,
    operator: "strictEqual",
  });
  Object.assign(error, { cause: Error(canary), payload: canary });
  Object.freeze(error);
  assert.deepEqual(
    JSON.parse(nativeEvidenceFailureLine("daemon-confinement-local-approval", error)),
    {
      diagnostic: "native-evidence-failure",
      phase: "daemon-confinement-local-approval",
      errorClass: "AssertionError",
      errorCode: "ERR_ASSERTION",
    },
  );
  for (const phase of [
    "candidate-metadata",
    "candidate-environment",
    "candidate-checkout",
    "candidate-checkout-head",
    "candidate-checkout-status",
    "candidate-workflow",
    "candidate-reference",
    "candidate-authentication",
    "candidate-producer-authentication",
    "candidate-zip-authentication",
    "candidate-staging-protection",
    "candidate-package-archive",
    "candidate-payload",
    "payload-protection",
    "payload-bytes",
    "evidence-producer",
    "evidence-fixture",
    "evidence-coordinator",
    "evidence-receipt",
    "native-output-protection",
    "service-native-setup",
    "service-dispatch-approval",
    "daemon-cleanup-stop",
  ]) {
    const line = nativeEvidenceFailureLine(phase, error);
    assert.equal(JSON.parse(line).phase, phase);
    assert.equal(line.includes(canary), false);
    assert.ok(Buffer.byteLength(line) <= 256);
  }
  const missing = Object.assign(Error(canary), { code: "ENOENT", path: canary });
  assert.deepEqual(JSON.parse(nativeEvidenceFailureLine("daemon-installed-module", missing)), {
    diagnostic: "native-evidence-failure",
    phase: "daemon-installed-module",
    errorClass: "Error",
    errorCode: "ENOENT",
  });
  assert.equal(
    JSON.parse(nativeEvidenceFailureLine("daemon-output", new TypeError(canary))).errorClass,
    "TypeError",
  );
  for (const value of [canary, `${canary}\nERR_ASSERTION`, {}, null, NaN, 23, Symbol(canary)]) {
    const line = nativeEvidenceFailureLine(value, { name: value, code: value, message: canary });
    assert.deepEqual(JSON.parse(line), {
      diagnostic: "native-evidence-failure",
      phase: null,
      errorClass: null,
      errorCode: null,
    });
    assert.equal(line.includes(canary), false);
    const inventory = distributionInventoryFailureLine(value, value, { name: value, code: value });
    assert.deepEqual(JSON.parse(inventory), {
      diagnostic: "distribution-inventory-failure",
      check: null,
      package: null,
      errorClass: null,
      errorCode: null,
    });
    assert.equal(inventory.includes(canary), false);
  }
  const inventory = distributionInventoryFailureLine("link-target", "fortipi-cli", error);
  assert.deepEqual(JSON.parse(inventory), {
    diagnostic: "distribution-inventory-failure",
    check: "link-target",
    package: "fortipi-cli",
    errorClass: "AssertionError",
    errorCode: "ERR_ASSERTION",
  });
  assert.equal(inventory.includes(canary), false);
  assert.ok(Buffer.byteLength(inventory) <= 512);
  assert.deepEqual(JSON.parse(distributionInstallPhaseLine("install-one", "fortipi-cli")), {
    diagnostic: "distribution-install-phase",
    phase: "install-one",
    package: "fortipi-cli",
  });
  const installLine = distributionInstallFailureLine(
    "dry-build",
    canary,
    error,
    Object.freeze({ code: null, timedOut: true, firstLimit: "deadline", stdout: canary }),
  );
  assert.deepEqual(JSON.parse(installLine), {
    diagnostic: "distribution-install-failure",
    phase: "dry-build",
    package: null,
    errorClass: "AssertionError",
    errorCode: "ERR_ASSERTION",
    resultObserved: true,
    code: null,
    timedOut: true,
    firstLimit: "deadline",
  });
  assert.equal(installLine.includes(canary), false);
  assert.ok(Buffer.byteLength(installLine) <= 512);
  for (const result of [
    null,
    { code: 256, timedOut: false, firstLimit: null },
    { code: -256, timedOut: false, firstLimit: null },
    { code: 1.5, timedOut: false, firstLimit: null },
    { code: 1, timedOut: "false", firstLimit: null },
    { code: 1, timedOut: false, firstLimit: "deadline" },
    { code: null, timedOut: true, firstLimit: null },
    { code: null, timedOut: true, firstLimit: canary },
  ]) {
    const observed = JSON.parse(distributionInstallFailureLine("prepare", canary, canary, result));
    assert.equal(observed.resultObserved, false);
    assert.equal(observed.code, null);
    assert.equal(observed.timedOut, null);
    assert.equal(observed.firstLimit, null);
    assert.equal(JSON.stringify(observed).includes(canary), false);
  }
  assert.equal(
    JSON.parse(
      distributionInstallFailureLine("inventory-before", "fortipi-cli", error, {
        code: 1,
        timedOut: false,
        firstLimit: null,
      }),
    ).resultObserved,
    false,
    "A different install stage cannot inherit a command result",
  );
  const failedDry = Object.freeze({ code: 3, timedOut: false, firstLimit: null });
  const legacyDry = distributionInstallFailureLine("dry-build", null, error, failedDry);
  assert.equal(
    legacyDry,
    '{"diagnostic":"distribution-install-failure","phase":"dry-build","package":null,"errorClass":"AssertionError","errorCode":"ERR_ASSERTION","resultObserved":true,"code":3,"timedOut":false,"firstLimit":null}',
  );
  for (const code of [
    "command_failed",
    "invalid_input_file",
    "input_too_large",
    "invalid_json",
    "invalid_operator_config",
    "invalid_deployment",
    "invalid_origin",
    "invalid_canonical_deployment_id_use_existing_public_protocol",
    "invalid_allowed_origins",
    "unknown_contract_schema",
    "invalid_contract_input",
    "free_policy_exceeds_canonical_bounds",
    "paid_deployment_id_required_bootstrap_native_then_reprepare",
    "paid_capability_required_for_canonical_deployment_id_reprepare",
    "inconsistent_capacity_bounds",
    "unsupported_model_provider",
    "oauth_provider_mismatch",
    "codex_requires_oauth",
    "custom_provider_endpoint_requires_review",
    "reserved_secret_reference",
    "unsupported_model_secret_binding",
    "linked_asset",
    "invalid_asset_type",
    "invalid_asset_manifest",
    "actual_service5_worker_assets_required",
    "noncanonical_asset_manifest",
    "incomplete_asset_manifest",
    "asset_closure_mismatch",
    "asset_integrity_failed",
    "image_provenance_changed",
    "canonical_worker_template_required",
    "unexpected_template_field",
    "invalid_free_template",
    "invalid_container_overlay",
    "reviewed_linux_image_digest_required",
    "image_context_changed",
    "migration_history_requires_explicit_repair",
    "invalid_prepare_receipt",
    "prepared_asset_identity_changed",
    "prepared_config_changed",
    "unexpected_prepared_file",
    "protected_acl_required",
    "unsafe_parent",
    "unsafe_protected_path",
    "protected_permissions_required",
    "protected_directory_failed",
    "untrusted_windows_system_root",
    "invalid_windows_user_home",
    "verified_node_26_13_required",
    "pinned_wrangler_required",
    "invalid_wrangler_bin",
    "explicit_wrangler_paths_required",
    "invalid_secret_input_mode",
    "wrangler_spawn_failed",
    "wrangler_cancelled_or_timed_out",
    "wrangler_failed_or_uncertain",
    "wrangler_dry_build_module_identity_failed",
  ]) {
    const collector = collectDryCliErrorCode();
    for (const byte of Buffer.from(`${code}\n`)) collector.observe(Buffer.from([byte]));
    const observed = collector.finish();
    assert.equal(observed, code, "A valid code survives arbitrary chunk boundaries");
    const line = distributionInstallFailureLine("dry-build", canary, error, failedDry, observed);
    assert.deepEqual(JSON.parse(line), { ...JSON.parse(legacyDry), dryCliErrorCode: code });
    assert.equal(line.includes(canary), false);
    assert.ok(Buffer.byteLength(line) <= 512);
    collector.observe(Buffer.from("protected_acl_required\n"));
    assert.equal(collector.finish(), null, "Finishing closes and clears the transient capture");
  }
  for (const text of [
    "",
    canary,
    `${canary}\n`,
    "protected_acl_required",
    "protected_acl_required\r\n",
    " protected_acl_required\n",
    "protected_acl_required \n",
    "protected_acl_required\n\n",
    "protected_acl_required\nunsafe_parent\n",
    `${canary}\nprotected_acl_required\n`,
    "protected_acl_required\u0000\n",
    `\uFEFFprotected_acl_required\n`,
    "x".repeat(256),
  ]) {
    const collector = collectDryCliErrorCode();
    collector.observe(Buffer.from(text));
    assert.equal(collector.finish(), null);
  }
  const overflow = collectDryCliErrorCode();
  overflow.observe(Buffer.alloc(128, 120));
  overflow.observe(Buffer.alloc(129, 120));
  overflow.observe(Buffer.from("protected_acl_required\n"));
  assert.equal(
    overflow.finish(),
    null,
    "More than 256 total bytes permanently invalidates capture",
  );
  assert.equal(
    JSON.parse(distributionInstallFailureLine("dry-build", null, error, failedDry, canary))
      .dryCliErrorCode,
    null,
  );
  for (const [phase, result] of [
    ["prepare", failedDry],
    ["inventory-before", failedDry],
    ["dry-build", { code: 0, timedOut: false, firstLimit: null }],
    ["dry-build", { code: null, timedOut: false, firstLimit: null }],
    ["dry-build", { code: 3, timedOut: true, firstLimit: "deadline" }],
    ["dry-build", { code: 3, timedOut: false, firstLimit: "deadline" }],
  ]) {
    assert.equal(
      distributionInstallFailureLine(phase, null, error, result, "protected_acl_required"),
      distributionInstallFailureLine(phase, null, error, result),
      "Only the current nonzero, non-timeout dry result receives the optional field",
    );
  }
});

test("native failure projection never invokes getters, coercion or nested value serialization", () => {
  let accesses = 0;
  const fail = () => {
    accesses++;
    throw Error(canary);
  };
  const opaque = Object.defineProperties(
    Object.create(Error.prototype),
    Object.fromEntries(
      ["name", "code", "message", "stack", "cause", "actual", "expected", "toJSON"].map((key) => [
        key,
        { get: fail },
      ]),
    ),
  );
  Object.assign(opaque, { toString: fail, [Symbol.toPrimitive]: fail });
  assert.deepEqual(JSON.parse(nativeEvidenceFailureLine(opaque, opaque)), {
    diagnostic: "native-evidence-failure",
    phase: null,
    errorClass: null,
    errorCode: null,
  });
  const inventory = distributionInventoryFailureLine(opaque, opaque, opaque);
  assert.deepEqual(JSON.parse(inventory), {
    diagnostic: "distribution-inventory-failure",
    check: null,
    package: null,
    errorClass: null,
    errorCode: null,
  });
  assert.equal(inventory.includes(canary), false);
  assert.equal(accesses, 0);
  const proxy = Proxy.revocable({}, {});
  proxy.revoke();
  assert.doesNotThrow(() => nativeEvidenceFailureLine(proxy.proxy, proxy.proxy));
  assert.equal(nativeEvidenceFailureLine(proxy.proxy, proxy.proxy).includes(canary), false);
  assert.doesNotThrow(() =>
    distributionInventoryFailureLine(proxy.proxy, proxy.proxy, proxy.proxy),
  );
  const result = Object.defineProperties(
    {},
    Object.fromEntries(
      ["code", "timedOut", "firstLimit", "stdout", "toJSON"].map((key) => [key, { get: fail }]),
    ),
  );
  const installLine = distributionInstallFailureLine("dry-build", canary, opaque, result);
  assert.deepEqual(JSON.parse(installLine), {
    diagnostic: "distribution-install-failure",
    phase: "dry-build",
    package: null,
    errorClass: null,
    errorCode: null,
    resultObserved: false,
    code: null,
    timedOut: null,
    firstLimit: null,
  });
  assert.equal(accesses, 0);
  assert.equal(installLine.includes(canary), false);
  assert.deepEqual(JSON.parse(distributionInstallPhaseLine(proxy.proxy, proxy.proxy)), {
    diagnostic: "distribution-install-phase",
    phase: null,
    package: null,
  });
  assert.doesNotThrow(() =>
    distributionInstallFailureLine(proxy.proxy, proxy.proxy, proxy.proxy, proxy.proxy),
  );
  for (const value of [opaque, proxy.proxy, Symbol(canary), { code: canary }, null]) {
    const line = distributionInstallFailureLine(
      "dry-build",
      canary,
      opaque,
      { code: 3, timedOut: false, firstLimit: null },
      value,
    );
    assert.equal(JSON.parse(line).dryCliErrorCode, null);
    assert.equal(line.includes(canary), false);
    assert.ok(Buffer.byteLength(line) <= 512);
  }
  assert.equal(accesses, 0);
});
