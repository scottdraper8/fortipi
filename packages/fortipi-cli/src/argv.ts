import { check } from "./errors.js";

const common = ["help", "json", "profile", "non-interactive", "timeout-ms"];
const flags = new Set(["help", "json", "non-interactive", "dry-run", "remote", "secret-stdin"]);
export const commands: Record<string, readonly string[]> = {
  init: ["config", "from"],
  setup: ["config", "directory", "from"],
  login: [],
  "models list": ["provider"],
  "models select": ["config", "provider", "model", "auth", "secret-ref"],
  "models configure": ["config", "provider", "auth", "secret-ref", "directory", "secret-stdin"],
  "models login": ["provider", "directory", "request-id"],
  "models status": ["provider"],
  "models logout": ["provider", "expected-version", "request-id"],
  "config validate": ["config", "remote"],
  "config get": [],
  "config apply": ["input", "expected-version"],
  prepare: ["config", "directory", "previous-directory"],
  deploy: ["directory", "bootstrap", "dry-run"],
  status: [],
  inspect: ["kind", "id"],
  "agents list": ["limit", "page-token"],
  "agents create": ["input"],
  "agents configure": ["input", "id"],
  "workspaces list": ["limit", "page-token"],
  "workspaces bind": ["input", "id"],
  "executors list": ["limit", "page-token"],
  "executors bind": ["input", "id"],
  "credentials create": ["input", "output"],
  "credentials rotate": ["input", "output", "id"],
  "credentials revoke": ["input", "id"],
  "executors revoke": ["input", "id"],
  audit: ["limit", "page-token"],
  usage: [],
  "export create": ["input"],
  "export backup": ["input"],
  "export status": ["id"],
  "export download": ["id", "artifact-id", "output", "max-bytes"],
  tui: [],
};
export interface Args {
  command: string;
  options: Record<string, string | true>;
  passthrough: string[];
}
export function argv(input: string[]): Args {
  const words: string[] = [];
  const options: Record<string, string | true> = {};
  let passthrough: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const arg = input[i] as string;
    if (arg === "--") {
      passthrough = input.slice(i + 1);
      break;
    }
    if (arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      words.push(arg);
      continue;
    }
    check(/^--[a-z][a-z-]*$/.test(arg), "invalid_option");
    const name = arg.slice(2);
    check(options[name] === undefined, "duplicate_option");
    if (flags.has(name)) options[name] = true;
    else {
      const next = input[++i];
      check(next && !next.startsWith("-"), "option_value_required");
      options[name] = next;
    }
  }
  const command = words.join(" ");
  if (!command && options.help) return { command: "", options, passthrough };
  check(Object.hasOwn(commands, command), "unknown_command");
  check(
    Object.keys(options).every(
      (name) => common.includes(name) || commands[command]?.includes(name),
    ),
    "unsupported_option",
  );
  check(command === "tui" || passthrough.length === 0, "unexpected_positional_argument");
  return { command, options, passthrough };
}
export function required(args: Args, key: string): string {
  const value = args.options[key];
  check(typeof value === "string" && value.length > 0, `required_${key.replaceAll("-", "_")}`);
  return value;
}
export function integer(
  args: Args,
  key: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = required(args, key);
  const n = Number(value);
  check(
    /^\d+$/.test(value) && Number.isSafeInteger(n) && n >= minimum && n <= maximum,
    "invalid_integer_option",
  );
  return n;
}
export function help(command = ""): string {
  return command
    ? `fortipi ${command}\nOptions: ${[...common, ...(commands[command] ?? [])].map((o) => `--${o}`).join(" ")}\nCredentials are never argv values. Operation input is non-secret JSON.\n`
    : `FortiPi management CLI\n${Object.keys(commands)
        .map((c) => `  fortipi ${c}`)
        .join("\n")}\nUse --help on a command.\n`;
}
