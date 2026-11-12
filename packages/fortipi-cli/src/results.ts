import type { CredentialRef, OperationValue, Protocol, RevocationReceipt } from "fortipi-contract";
import type { PrepareReceipt } from "./assets.js";
import type { SetupResult } from "./setup.js";

export interface DeploymentReceipt {
  workerName: string;
  origin: string;
  targets: string[];
  workerVersionId: string;
  sourceCommit: string;
  packageVersion: string;
  assetManifestSha256: string;
  configSha256: string;
}
export interface CredentialDelivery {
  credential: CredentialRef;
  role: "admin" | "client" | "executor";
  state: "issued";
  revocation?: RevocationReceipt;
}
export interface CatalogModel {
  providerId: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  input: readonly string[];
}
export interface ModelListing {
  items: CatalogModel[];
  workersAi: { providerId: string; catalog: string; auth: string };
  deployed:
    | { state: "not-configured" }
    | { state: "unavailable" }
    | { state: "observed"; items: Protocol["models"] };
}
export type CommandOperation =
  | "getProtocol"
  | "getAdminHealth"
  | "getConfiguration"
  | "patchConfiguration"
  | "listAgents"
  | "createAgent"
  | "configureAgent"
  | "describeAgent"
  | "getConversation"
  | "describeTask"
  | "describeJob"
  | "describeApproval"
  | "listWorkspaces"
  | "createWorkspace"
  | "rebindWorkspace"
  | "listExecutors"
  | "revokeCredential"
  | "revokeExecutor"
  | "listAudit"
  | "getUsage"
  | "createExport"
  | "createBackup"
  | "getAdminOperation"
  | "getProviderAuthStatus"
  | "deleteProviderAuth";
export type CommandResult =
  | SetupResult
  | OperationValue<CommandOperation>
  | PrepareReceipt
  | DeploymentReceipt
  | CredentialDelivery
  | { help: string }
  | {
      valid: true;
      infrastructure?: Protocol["infrastructure"];
      backends?: Protocol["backends"];
      models?: Protocol["models"];
    }
  | { state: "initialized" | "selected" | "cloudflare_login_completed" }
  | { state: "binding_secret_uploaded"; rolloutEvidence: "must-be-renewed" }
  | {
      state: "dry-build-completed";
      sourceCommit: string;
      assetManifestSha256: string;
      workerBytesVerified: true;
    }
  | ModelListing
  | { exitCode: number }
  | { bytes: number; sha256: string };
