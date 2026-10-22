# References and dependencies

PiCall's architecture was informed by [ALange/Piper](https://github.com/ALange/Piper),
by Adam Lange, licensed under Apache-2.0. PiCall is an independent implementation:
it does not redistribute Piper source, its dashboard, or its container stack.

The bundled runtime dependency is
[@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi),
version 1.4.0, licensed under MIT. Its package and transitive dependencies retain
their respective license notices. PiCall communicates through Pi's documented
JSONL RPC protocol and uses its public extension API for context budgeting.
