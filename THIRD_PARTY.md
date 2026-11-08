# References and dependencies

PiCall's architecture was informed by [ALange/Piper](https://github.com/ALange/Piper),
by Adam Lange, licensed under Apache-2.0. PiCall is an independent implementation:
it does not redistribute Piper source, its dashboard, or its container stack.

The runtime dependencies are `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-ai`, version 1.4.0, from
[earendil-works/pi](https://github.com/earendil-works/pi), licensed under MIT.
These packages and their transitive dependencies retain their respective notices.
PiCall communicates through Pi's documented JSONL RPC protocol, uses its public
extension API for tool diagnostics, and uses Pi's own thinking-level helper for
model capability discovery.

The built-in HTTP research tools are adapted from this repository's MIT-licensed
Cloudflare branch. Only the tool contracts and HTTP implementations are reused;
the local package does not include Cloudflare Agents, Pi Durable, or Wrangler.
