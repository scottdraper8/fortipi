# Accepted session steering
- User explicitly requested a goal; completion requires deployment. Goal created and active.
- User granted full local/GitHub access. No repeated permission prompts for ordinary task work.
- Manual input means API keys/credentials. User will put them directly in GitHub secrets.
- Do not implement extra credential entry helpers.
- Derived release choice: npm for independently distributable TS packages, GitHub Releases for release artifacts, Cloudflare for service.
- Derived first deployed model test: Workers AI binding, avoiding a separate provider credential. Preserve configurable external providers.
