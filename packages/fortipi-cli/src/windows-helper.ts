import { userInfo } from "node:os";
import { win32 } from "node:path";
import { types } from "node:util";
import { check } from "./errors.js";

export interface WindowsAclFailure {
  phase: "protect" | "verify" | null;
  stage: "helper" | "execute" | null;
  exitCode: number | null;
  code: string | null;
  killed: boolean | null;
  signal: "SIGTERM" | "SIGKILL" | "SIGINT" | null;
}
export type WindowsAclFailureObserver = (failure: WindowsAclFailure) => void;

/** Original child metadata only: no accessors, proxy traps or diagnostic text. */
export function projectWindowsAclFailure(
  phase: unknown,
  stage: unknown,
  error: unknown,
): WindowsAclFailure {
  const object = error && typeof error === "object" && !types.isProxy(error) ? error : null;
  const own = (key: string): unknown => {
    try {
      const descriptor = object ? Object.getOwnPropertyDescriptor(object, key) : undefined;
      return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    } catch {
      return undefined;
    }
  };
  const code = own("code"),
    killed = own("killed"),
    signal = own("signal");
  return {
    phase: phase === "protect" || phase === "verify" ? phase : null,
    stage: stage === "helper" || stage === "execute" ? stage : null,
    exitCode:
      typeof code === "number" && Number.isInteger(code) && Math.abs(code) <= 255 ? code : null,
    code:
      typeof code === "string" &&
      [
        "ENOENT",
        "EACCES",
        "EPERM",
        "EINVAL",
        "ENOTDIR",
        "ETIMEDOUT",
        "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      ].includes(code)
        ? code
        : null,
    killed: typeof killed === "boolean" ? killed : null,
    signal: signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGINT" ? signal : null,
  };
}

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
