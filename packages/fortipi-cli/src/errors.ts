import type { InfrastructurePressure } from "fortipi-contract";

/** Only contract enums and numbers survive error projection. No server text or resource identifiers. */
export type SafePressure = Pick<
  InfrastructurePressure,
  "resource" | "source" | "measurement" | "limit" | "remaining" | "resetAt" | "retryAt" | "action"
>;

export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly pressure: Readonly<SafePressure> | undefined;
  constructor(code: string, exitCode = 1, pressure?: SafePressure) {
    super(code);
    this.code = code;
    this.exitCode = exitCode;
    this.pressure = pressure ? Object.freeze({ ...pressure }) : undefined;
  }
}
export function errorDiagnostic(error: CliError): string {
  return error.pressure
    ? JSON.stringify({ error: { code: error.code, pressure: error.pressure } })
    : error.code;
}
export function check(value: unknown, code: string, exitCode = 2): asserts value {
  if (!value) throw new CliError(code, exitCode);
}
