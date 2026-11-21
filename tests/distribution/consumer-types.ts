/** Compiled in the fresh consumer with its installed strict declaration graph. */
export function consumerTypes(scope: string): string {
  return `import type { Protocol } from '@${scope}/fortipi-contract';
import { FortiPiClient } from '@${scope}/fortipi-client';
import { FortiPiClient as Browser } from '@${scope}/fortipi-client/browser';
import { FortiPiClient as NodeClient } from '@${scope}/fortipi-client/node';
import { Controller } from '@${scope}/fortipi-tui';
import { ExecutorRuntime } from '@${scope}/fortipi-executor';
import { runCommand } from '@${scope}/fortipi-cli';
export type PublicProtocol = Protocol;
const surface: [typeof FortiPiClient, typeof Browser, typeof NodeClient, typeof Controller, typeof ExecutorRuntime, typeof runCommand] = [FortiPiClient, Browser, NodeClient, Controller, ExecutorRuntime, runCommand]; void surface;
`;
}
