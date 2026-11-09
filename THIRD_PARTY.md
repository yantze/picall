# References and dependencies

PiCall's original architecture was informed by [ALange/Piper](https://github.com/ALange/Piper),
by Adam Lange, licensed under Apache-2.0. PiCall does not redistribute Piper source,
dashboard, or container stack.

The local runtime uses `@earendil-works/pi-durable`, `pi-ai`, `pi-schema`, and
`chord`, pinned to 1.5.0 from [earendil-works/pi](https://github.com/earendil-works/pi),
licensed under MIT. Their transitive dependencies retain their respective notices.
SQLite is accessed through Node's built-in module and Pi Durable's official adapter.
The local package no longer includes `pi-coding-agent` or Cloudflare Agents.

The built-in HTTP research tools are adapted from this repository's MIT-licensed
Cloudflare branch, sharing the search/read contracts and HTTP behavior. The
Cloudflare branch remains an independent deployment target.
