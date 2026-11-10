## Main Idea
You're going to use the big-build skill to get this from idea to initial release (v0.1.0) autonomously.

## Initial Prompt & `big-build` Scratchwork
- Save this initial prompt somewhere so the auditor(s) relevant to design integrity can review it in addition to the specific tranches they're assigned. It should persist until I specifically dictate it can be removed. No edits should be applied to this intial prompt aside form typo, linting, and formatting fixes
- Context compaction is good but many compaction events in long-horizon work can lead the agent astray. The `big-build` workflow is designed to prevent that but referring to this initial prompt after each compaction event will be useful in case the `big-build` workflow itself has started to drift and needs to be corrected on the fly. With that being said this prompt references docuements that are quite extensive that dont need to be read everytime. The `big-build` workflow will properly ingest them and orchestrate accordingly.
- It will also be helpful to keep a brief agent-resume.md file that agents write to before compaction and read from afterward. This shodul be concise pointing the agent to the proper files, as well as providing a brief statement regarding what work needs to be resumed.
- The `big-build` workflow naturally persists docs so agents can refer to them, but its imperative we dont over-document or excessivley note what we've done, what we tried and didn't work, etc. While it may be important to explain reasoning or guard against a possible bad choice I'm saying to be concientious of how much context you're addignto the workspace. In this long-horizon task the working docs/scratchpad could become excessively large and throttle/choke the agent after each compaction event when it tires to understand the project. Therefore, concientious doc keeping and organized doc keepign and pointers to agents before and after compaction events is crucial for success

## Manual First Step
The first step will be manual, in that you'll need to get and store auth securely so that you cant see it but can use it:
- You will need access to a cloudflare account with the appropriate permissiosn to do all the things this project entials, so carefully
- Determine the proper ecosystems that this should deploy to. Shoudl this be somethign available via npm/pnpm/yarn? Shodul it just be a bash scritp installer? Should it be a homebrew package? Those arent the only possibilities, but examples of platforms/packaging to consider for the release. Once you've determiend what makes sense for this project then so indicate and acquire the auth/secrets you need.
- You do have access to github via gh and the graphql api and the typical git commands
- If theres any other access you forsee needing let me know in this step so you can acquire it. Its imperative we dont interrupt the autonmous long-horizon work.
- Note that auth can be stored locally in env files that i make or in github or whatever other secure environemnt makes sense in the context of an agent needing to build this from the ground up and then continue to maintain it

## Autonomous Work
- The reference documents that discuss the project proposal are located here:
    - "~/Downloads/fortipi-architecture.md"
    - "~/Downloads/fortipi-client-interface-addendum.md"
- This is what `big-build` will design around

### Gitops
- Use pre-commit, but tailor the hooks to this package rather than just usign the standard assortment of hooks.
- pre-commit should include linting, typing, formatting, secret checking, file size checkign, etc. Eveyrhting that woudl make sense for this repo and be a part of pre-commit
- We'll have a release workflow that publishes to github and also the platforms we established in the first manual step. This should do so as securely as possible.

### Security
- Initialize unstale in the repo with unstale init and be sure it utilized/set up properly to work auomatically
- Use the current latest availabe (and secure) version of packages but pin all deps so we're safe from supply-chain attacks
- Use step-securiy's harden-runners for github actions
- Configure github's dependabot so that it makes prs when there's security issues, and it shoudl update the package yet pin the version. dependabot should not be making prs just for package updates that arent security related

### Licensing
- This will use the Sustainable Use License 1.0
- Be strict about licensing so that we include the proper licenses needed for any deps that may have conflicting license, or avoid deps that would derail our project's licensing
- Ensure that licensing of deps is kept track of. This may be done automatically by whatever packageme manager we use for this project, or we may have to build our own workflow

### Speed and Optimization
- Strict adherence to KISS and DRY methodologies should keep this project lean and tehrefore fast. Rememember taht simplicity is the ultimate sophisitcation and that overnengineerign shoudl be avoided. This is not an excuse to take shortcuts but to evaluate if a tool, or a current impleemntation is actually the wisest
- Speed of this project is a top priority. its imperative that computationally expensive or potnetially latent operations are done asynchronously when possible and we consistently optimize for best Big O outcomes.
- Consider how the regualr pi harness is faster than claude code and codex simpyl because it has less bloat. Agnets dont get fatigued or inundated with decisions.

### Testing
- Review the complete corpus of these documents that discuss testing:
    - "~/Downloads/Evidence_Governed_Agentic_Reverse_Engineering.pdf"
    - "~/Downloads/behavioral_testing_overhaul_agent_protocol.md"
    - "~/Downloads/Interrogating_the_Codebase_Behavioral_Comprehension_Research_Paper.pdf"
- Those documents regard entering an exisiting codebase and reverse-engineering/designing tests that actually adhere to certain standards. Obviosuly this is not an existing codebase but the principles can be extrapolated. Your tests need to adhere to them
- Avoid just spamming tests and callign it good when they pass.
- `big-build` needs to guide agents into beign careful and methodical in implementign tests. Udnerstand that more tests is not necessarily better

## Underlying Principle
The proposal documents provide a detailed technical reference, but the underlying principle of FortiPi is to **extend durability beyond the agent harness to the infrastructure supporting the agent itself.**

Existing solutions like Pi Pocket leverage Pi Durable to persist conversations, execution state, and unfinished tasks. However, their default architecture still concentrates the agent runtime, storage, and tool execution on a single host. If that host becomes unavailable, connected clients lose access to the agent. Although Pi Durable can recover unfinished work, recovery depends on restoring access to the original storage and a compatible execution environment. The conversation is durable, but the infrastructure remains a single point of failure.

FortiPi expands on this concept by **decoupling agent state, filesystem storage, and tool execution from any particular physical machine.** Conversation and execution state are persisted through Cloudflare Durable Objects, allowing the agent runtime to recover on replacement infrastructure. Files can be maintained independently through Cloudflare Computer, while tools can execute on interchangeable local devices or cloud-based environments.

The objective is not to eliminate centralized coordination, but to eliminate dependence on a specific host. A single logical agent can retain authoritative state while its execution environment and connected clients change independently.

This creates a more resilient and flexible agent architecture in which losing an individual execution device does not necessarily mean losing the agent, its conversation, or its committed workspace. Recovering interrupted local operations or transferring work between devices still requires explicit synchronization and recovery mechanisms.

**The central principle is that an agent's continuity should not depend on the continued availability of the machine executing its work.**
