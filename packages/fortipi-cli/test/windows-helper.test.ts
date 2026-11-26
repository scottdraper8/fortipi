import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CliError } from "../dist/errors.js";
import { checkProtected, protectDirectory, reserveProtected } from "../dist/profiles.js";
import {
  projectWindowsAclFailure,
  type WindowsAclFailure,
  windowsAclHelper,
} from "../dist/windows-helper.js";

test("Windows ACL helper fixes executable and module lookup to guarded OS paths", async () => {
  const helper = windowsAclHelper("C:\\Windows", "C:\\Users\\FortiPi");
  assert.equal(helper.executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(win32.isAbsolute(helper.executable));
  assert.equal(
    helper.env.PATH,
    "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
  );
  assert.equal(helper.env.PSModulePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
  assert.deepEqual(
    Object.keys(helper.env).sort(),
    [
      "APPDATA",
      "LOCALAPPDATA",
      "PATH",
      "PSModulePath",
      "SystemRoot",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "WINDIR",
    ].sort(),
  );
  // A cwd executable or user module directory cannot enter either startup lookup path.
  assert.equal(helper.env.PATH?.includes("C:\\Users\\FortiPi"), false);
  for (const root of [
    "",
    ".",
    "Windows",
    "C:Windows",
    "C:\\fake",
    "C:\\Windows\\..\\fake",
    "\\\\server\\Windows",
    "C:\\Windows;C:\\fake",
  ])
    assert.throws(
      () => windowsAclHelper(root, "C:\\Users\\FortiPi"),
      /untrusted_windows_system_root/,
    );

  const empty = {
    phase: null,
    stage: null,
    exitCode: null,
    code: null,
    killed: null,
    signal: null,
  };
  const canary = "private-acl-path-identity-output-canary";
  for (const code of [
    "ENOENT",
    "EACCES",
    "EPERM",
    "EINVAL",
    "ENOTDIR",
    "ETIMEDOUT",
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  ]) {
    assert.deepEqual(projectWindowsAclFailure("protect", "execute", { code, killed: false }), {
      ...empty,
      phase: "protect",
      stage: "execute",
      code,
      killed: false,
    });
  }
  for (const code of [-255, 0, 1, 255]) {
    assert.deepEqual(
      projectWindowsAclFailure("verify", "execute", { code, killed: true, signal: "SIGTERM" }),
      {
        ...empty,
        phase: "verify",
        stage: "execute",
        exitCode: code,
        killed: true,
        signal: "SIGTERM",
      },
    );
  }
  for (const signal of ["SIGTERM", "SIGKILL", "SIGINT"]) {
    assert.equal(projectWindowsAclFailure("verify", "execute", { signal }).signal, signal);
  }
  for (const code of [
    -256,
    256,
    1.5,
    NaN,
    Infinity,
    canary,
    `${canary}\nENOENT`,
    {},
    Symbol(canary),
  ]) {
    const projected = projectWindowsAclFailure(canary, canary, {
      code,
      killed: canary,
      signal: canary,
      message: canary,
      stdout: canary,
      stderr: canary,
    });
    assert.deepEqual(projected, empty);
    assert.equal(JSON.stringify(projected).includes(canary), false);
  }
  assert.deepEqual(projectWindowsAclFailure("protect", "helper", null), {
    ...empty,
    phase: "protect",
    stage: "helper",
  });
  assert.deepEqual(
    projectWindowsAclFailure(
      null,
      null,
      Object.create({ code: 1, killed: true, signal: "SIGINT" }),
    ),
    empty,
  );
  let accesses = 0;
  const fail = () => {
    accesses++;
    throw Error(canary);
  };
  const opaque = Object.defineProperties(
    {},
    Object.fromEntries(
      [
        "code",
        "killed",
        "signal",
        "name",
        "message",
        "stack",
        "stdout",
        "stderr",
        "cmd",
        "path",
        "toJSON",
      ].map((key) => [key, { get: fail }]),
    ),
  );
  Object.assign(opaque, { toString: fail, [Symbol.toPrimitive]: fail });
  assert.deepEqual(projectWindowsAclFailure(opaque, opaque, opaque), empty);
  const proxy = new Proxy(
    {},
    { get: fail, getOwnPropertyDescriptor: fail, ownKeys: fail, getPrototypeOf: fail },
  );
  assert.deepEqual(projectWindowsAclFailure(proxy, proxy, proxy), empty);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(projectWindowsAclFailure(revoked.proxy, revoked.proxy, revoked.proxy), empty);
  assert.equal(accesses, 0);

  if (process.platform !== "win32") return;
  const directory = await realpath(await mkdtemp(join(tmpdir(), "fortipi-windows-acl-")));
  const target = join(directory, "owned");
  let failed = false;
  let failure: unknown;
  try {
    let observation: WindowsAclFailure | undefined;
    try {
      const observe = (value: WindowsAclFailure) => {
        observation = value;
      };
      await protectDirectory(target, observe);
      await checkProtected(target, true, observe);
      const file = join(target, "owned.json");
      const handle = await reserveProtected(file);
      await handle.close();
      await checkProtected(file);
      assert.equal(observation, undefined);
    } catch (error) {
      try {
        process.stderr.write(
          `${JSON.stringify({ diagnostic: "windows-acl-failure", ...(observation ?? projectWindowsAclFailure(null, null, null)) })}\n`,
        );
      } catch {}
      throw error;
    }
    try {
      const actualHelper = windowsAclHelper();
      const pending = promisify(execFile)(
        actualHelper.executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop';$p=$env:FORTIPI_ACL_TARGET;" +
            "$attributes=[IO.File]::GetAttributes($p);if($attributes -band [IO.FileAttributes]::ReparsePoint){throw 'link'};" +
            "$a=[IO.Directory]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]'Owner,Access');" +
            "$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'ReadAndExecute','Allow'));" +
            "[IO.Directory]::SetAccessControl($p,$a);",
        ],
        {
          env: { ...actualHelper.env, FORTIPI_ACL_TARGET: target },
          timeout: 10000,
          maxBuffer: 4096,
          windowsHide: true,
        },
      );
      pending.child.stdin?.on("error", () => undefined);
      pending.child.stdin?.end();
      await pending;
    } catch {
      throw Error("Windows ACL negative fixture setup failed");
    }
    const negatives: WindowsAclFailure[] = [];
    const observerError = Error(canary);
    await assert.rejects(
      checkProtected(target, true, (value) => {
        negatives.push(value);
        throw observerError;
      }),
      (error: unknown) =>
        error instanceof CliError &&
        error.code === "protected_acl_required" &&
        error.exitCode === 3 &&
        error !== observerError,
    );
    assert.equal(negatives.length, 1);
    const negative = negatives[0];
    assert.ok(negative);
    assert.equal(negative.phase, "verify");
    assert.equal(negative.stage, "execute");
    assert.ok(typeof negative.exitCode === "number" && negative.exitCode !== 0);
    assert.equal(negative.code, null);
    assert.equal(negative.killed, false);
    assert.equal(negative.signal, null);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  } catch {
    if (!failed) {
      failed = true;
      failure = Error("Windows ACL fixture cleanup failed");
    }
  }
  if (failed) throw failure;
});
