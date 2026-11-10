# References and dependencies

PiCall's original architecture was informed by [ALange/Piper](https://github.com/ALange/Piper),
by Adam Lange, licensed under Apache-2.0. PiCall does not redistribute Piper source,
dashboard, or container stack.

The local runtime uses `@earendil-works/pi-durable`, `pi-ai`, `pi-schema`, and
`chord`, pinned to 1.5.0 from [earendil-works/pi](https://github.com/earendil-works/pi),
licensed under MIT. Their transitive dependencies retain their respective notices.
SQLite is accessed through Node's built-in module and Pi Durable's official adapter.
The published local package does not include `pi-coding-agent` or Cloudflare Agents.
The Cloudflare workspace additionally uses MIT-licensed `agents` 0.33.0 from
[cloudflare/agents](https://github.com/cloudflare/agents). Wrangler, Miniflare,
TypeScript, tsx and Playwright are development and verification dependencies.

The built-in HTTP research tools are adapted from this repository's MIT-licensed
Cloudflare branch (source commit `0573e12`), with local integration baseline
`374444e`. Both adapters now share the research implementation on main. The
original Cloudflare branch remains a historical release reference.
