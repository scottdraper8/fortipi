# FortiPi

FortiPi is being built for v0.1.0: a self-managed Pi Durable agent service on Cloudflare with independently configured workspaces, clients and tool execution.

The release is complete only after deployment and verification. Public contracts, clients, control, workspace and executor source are present; durable-service integration and release qualification are in progress.

The public distribution will use independently installable npm packages and GitHub Release artifacts. Cloudflare Workers and Durable Objects host the service; the first live model check uses a Workers AI binding.

Agent entry point: [AGENTS.md](AGENTS.md). Original requirements: [.agent-docs/initial-prompt.md](.agent-docs/initial-prompt.md).

The [management CLI](packages/fortipi-cli/README.md) currently supports contract preparation and protected administration. Its genuine embedded Worker assets, installed dry-build and guided setup remain dependent on the integrated durable service. See the [operator guide](docs/operator-guide.md) for configuration and credential boundaries. No deployment or publication is claimed.
