# FortiPi

FortiPi is being built for v0.1.0: a self-managed Pi Durable agent service on Cloudflare with independently configured workspaces, clients and tool execution.

The release is complete only after deployment and verification. This repository currently contains the preserved design inputs and access preflight.

The public distribution will use independently installable npm packages and GitHub Release artifacts. Cloudflare Workers and Durable Objects host the service; the first live model check uses a Workers AI binding.

Agent entry point: [AGENTS.md](AGENTS.md). Original requirements: [.agent-docs/initial-prompt.md](.agent-docs/initial-prompt.md).
