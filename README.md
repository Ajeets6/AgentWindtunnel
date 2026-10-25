# AgentWindTunnel

A proposed local-first test environment for ecommerce refund agents, checking actual backend outcomes alongside message accuracy.

- [Product idea](Idea.md)
- [Application design](DESIGN.md): TypeScript web application, local SQLite storage, deterministic assertions, Laya System One judging, other local models, and optional OpenAI-compatible inference.
- [Test guide](TESTING.md): initial refund scenarios, Laya/Jev contracts, injection defenses, API/browser security, and incremental test adapters.
- [Environment preflight](ENVIRONMENT.md): verified tools, dependency audit, available updates, local inference checks, and remaining setup gates.

Run `npm test` with Node 24.15+; no dependencies or model downloads are required. Application contracts are TODO until implemented. `npm run test:release` fails on missing implementation so TODOs cannot count as release validation.

The repository contains the architecture specification and test foundation. The application has not yet been implemented; `main.py` is the original placeholder.
