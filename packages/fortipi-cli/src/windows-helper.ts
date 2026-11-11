import { userInfo } from "node:os";
import { win32 } from "node:path";
import { check } from "./errors.js";

/** Fixed Windows utility/module paths; ambient PATH and PowerShell module paths confer no authority. */
export function windowsAclHelper(
  systemRoot = process.env.SystemRoot,
  userHome = userInfo().homedir,
): {
  executable: string;
  env: NodeJS.ProcessEnv;
} {
  check(systemRoot && /^[a-z]:\\windows$/i.test(systemRoot), "untrusted_windows_system_root", 3);
  check(win32.isAbsolute(userHome), "invalid_windows_user_home", 3);
  const psHome = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
  const local = win32.join(userHome, "AppData", "Local");
  return {
    executable: win32.join(psHome, "powershell.exe"),
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      USERPROFILE: userHome,
      LOCALAPPDATA: local,
      APPDATA: win32.join(userHome, "AppData", "Roaming"),
      TEMP: win32.join(local, "Temp"),
      TMP: win32.join(local, "Temp"),
      PATH: [win32.join(systemRoot, "System32"), systemRoot, psHome].join(";"),
      PSModulePath: win32.join(psHome, "Modules"),
    },
  };
}
