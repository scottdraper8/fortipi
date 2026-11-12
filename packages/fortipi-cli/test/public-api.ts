import type {
  CatalogModel,
  CommandContext,
  CommandResult,
  CredentialDelivery,
  DeploymentReceipt,
  OperatorConfig,
  PrepareReceipt,
  SafePressure,
  SetupResult,
} from "fortipi-cli";
import { AdminClient, CliError, operatorConfig, readConfig, runCommand } from "fortipi-cli";

// Also compiled against the actual installed distribution by install-harness.ts.
export async function consume(
  config: OperatorConfig,
  context: CommandContext,
): Promise<CommandResult> {
  const validated: OperatorConfig = operatorConfig(config);
  const loaded: OperatorConfig = await readConfig("operator.json");
  void validated;
  void loaded;
  return runCommand(["config", "validate", "--config", "operator.json"], context);
}
export type PublicDtos =
  | CatalogModel
  | CredentialDelivery
  | DeploymentReceipt
  | PrepareReceipt
  | SetupResult
  | SafePressure;
export const publicClasses = [AdminClient, CliError];
