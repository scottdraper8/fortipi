import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";
import { windowsAclHelper } from "../dist/windows-helper.js";

test("Windows ACL helper fixes executable and module lookup to guarded OS paths", () => {
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
});
