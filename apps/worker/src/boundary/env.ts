import type { DurableObject } from "cloudflare:workers";
import type {
  ContainerHostHolder,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import type { Models } from "@earendil-works/pi-ai/models";
import type { AgentSessionRpc } from "./agent-session.js";
import type { ControlPlaneRpc } from "./control-plane.js";
import type * as D from "./dto.js";
import type { ExecutionBackend } from "./execution-backend.js";
import type { WorkspaceObjectRpc } from "./workspace-object.js";
import type { WorkspaceProvider, WorkspaceTransfer } from "./workspace-provider.js";
export type ControlPlaneObject = DurableObject<Env> & ControlPlaneRpc;
export type AgentSessionObject = DurableObject<Env> & AgentSessionRpc;
export type WorkspaceObject = DurableObject<Env> & WorkspaceObjectRpc;
export type LinuxContainerObject = DurableObject<Env> & ContainerHostHolder;
export interface Env {
  CONTROL_PLANE: DurableObjectNamespace<ControlPlaneObject>;
  AGENT_SESSIONS: DurableObjectNamespace<AgentSessionObject>;
  WORKSPACES: DurableObjectNamespace<WorkspaceObject>;
  AI: Ai;
  LOADER?: WorkerLoader;
  LINUX_CONTAINERS?: DurableObjectNamespace<LinuxContainerObject>;
  FORTIPI_CONFIG: D.Configuration | { version: 1; infrastructure: D.InfrastructurePolicy };
  FORTIPI_ADMIN_TOKEN: string;
  FORTIPI_MODEL_AUTH_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}
export interface FactoryDependencies {
  env: Env;
  control: ControlPlaneRpc;
  authority: WorkspaceObjectRpc;
  transfer: WorkspaceTransfer;
  storage: DurableObjectStorage;
}
export type WorkspaceProviderFactory = (
  config: D.WorkspaceConfig,
  deps: FactoryDependencies,
) => Promise<D.Outcome<WorkspaceProvider>>;
export type ExecutionBackendFactory = (
  config: D.BackendConfig,
  deps: FactoryDependencies,
) => Promise<D.Outcome<ExecutionBackend>>;
export interface CloudJsDependencies extends FactoryDependencies {
  loader: WorkerLoader;
}
export interface LinuxDependencies extends FactoryDependencies {
  container: IWorkspaceContainerAPI;
  host: ContainerHostHolder;
}
export type ModelsFactory = (config: D.ModelConfig[], env: Env) => Promise<D.Outcome<Models>>;
export type CreateFortiPiModels = ModelsFactory;
