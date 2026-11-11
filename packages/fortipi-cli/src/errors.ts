export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  constructor(code: string, exitCode = 1) {
    super(code);
    this.code = code;
    this.exitCode = exitCode;
  }
}
export function check(value: unknown, code: string, exitCode = 2): asserts value {
  if (!value) throw new CliError(code, exitCode);
}
