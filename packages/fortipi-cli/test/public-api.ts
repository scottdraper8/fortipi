import type {
  CatalogModel,
  CommandContext,
  CommandResult,
  CredentialDelivery,
  DeploymentReceipt,
  OperatorConfig,
  PrepareReceipt,
} from "fortipi-cli";
import { AdminClient, CliError, operatorConfig, readConfig, runCommand } from "fortipi-cli";

// A source-consumer boundary check. Installed strict-consumer evidence remains dependent on5.
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
export type PublicDtos = CatalogModel | CredentialDelivery | DeploymentReceipt | PrepareReceipt;
export const publicClasses = [AdminClient, CliError];
