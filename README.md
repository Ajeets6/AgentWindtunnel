# AgentWindTunnel

A local-first refund-agent test workbench. The implemented foundation runs scripted agents against an isolated mock shop, records backend outcomes in SQLite, and reports deterministic failures alongside message judgments.

- [Product idea](Idea.md)
- [Application design](DESIGN.md): TypeScript web application, local SQLite storage, deterministic assertions, Laya System One judging, other local models, and optional OpenAI-compatible inference.
- [Test guide](TESTING.md): initial refund scenarios, Laya/Jev contracts, injection defenses, API/browser security, and incremental test adapters.
- [Environment preflight](ENVIRONMENT.md): verified tools, dependency audit, available updates, local inference checks, and remaining setup gates.

## Setup

Use Node **24.15+** (prefer the latest Node 24 LTS patch) and npm:

```powershell
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm audit
```

No model, Python environment, API key or paid service is needed for scripted runs. Dependencies are pinned in `package-lock.json`. Python is reserved for the future Laya inference sidecar; the starter `main.py` is unused by the simulator.

## Open the local workspace

```powershell
npm run dev
# Or: npm run build, then npm start
```

Open the **one-time sign-in link printed in the terminal**. The API and production React build share `http://127.0.0.1:3000`; the service binds only to loopback. The bootstrap token is removed from browser history and exchanged for an HttpOnly, SameSite cookie. Sessions expire after 12 hours; restarting the server creates a fresh sign-in link. No keys are stored in browser storage.

The UI launches authored refund cases, repeats suites, streams progress, filters outcomes, inspects conversations/checks/before-after state, and downloads JSON/JUnit reports. Saved suites survive restart. Scenario browsing is read-only. Use the synthetic-judgment checkbox explicitly for fixture regression work; ordinary runs keep semantic checks in review. The Judge lab currently lists unresolved checks; human adjudication is not yet implemented.

Server data lives in `data/workbench.sqlite` and `data/artifacts`, independently of the CLI database. Set `AW_PORT` to choose another loopback port and `AW_DATA_DIR` to use another data directory. A process lock prevents two workbench instances from operating on the same database. Graceful shutdown preserves pending work for restart. `npm run dev` builds and serves production assets; run it again after frontend source changes (it is not a hot-reload server).

### Local API

The browser uses its session cookie. Internal clients can use a session's bearer token; mutations also require that session's `X-AW-CSRF` proof. Browser mutations require the exact configured Origin. Host validation applies to every request.

| Route | Purpose |
| --- | --- |
| `POST /api/session/bootstrap` | Exchange the startup token for a browser session |
| `GET /api/session` | Session CSRF proof and local capability state |
| `GET /api/scenarios`, `GET /api/agents`, `GET /api/settings` | Authenticated catalog and current capabilities |
| `GET /api/suites`, `POST /api/suites` | List owned suites or enqueue bounded scripted work |
| `GET /api/suites/:id` | Owned suite with execution traces and snapshots |
| `POST /api/suites/:id/cancel` | Persist cancellation and stop additional work |
| `GET /api/suites/:id/events` | Authenticated SSE, replayed after `Last-Event-ID` |
| `GET /api/executions/:id` | Owned execution details |
| `GET /api/suites/:id/export?format=json\|junit` | Inert attachment export |
| `GET /api/artifacts/:id` | Owned attachment with canonical-path checks |

Suite requests accept `scenarioPack: "refunds-v1"`, `agentId: "fixture-safe"`, `repeats: 1..10`, optional unique `scenarioIds`, and optional `fixtureJudges` (default false). A suite is capped at 400 executions; each owner may have eight queued/running suites. The agent ID is retained for contract compatibility; it replays the authored actions, including deliberate unsafe actions, rather than guaranteeing successful agent behavior.

## Run the simulator

```powershell
# Happy path using explicitly synthetic guard/judge answers
npm run simulate -- --scenario RF-001 --fixture-judges

# Deliberately buggy agent: two refunds after a committed timeout; exits 1
npm run simulate -- --scenario RF-018 --fixture-judges

# All 40 cases with two independent executions each, exported for inspection
npm run simulate -- --fixture-judges --repeats 2 --output data/results.json

# CI export (the pack deliberately contains failing agent behaviors)
npm run simulate -- --fixture-judges --format junit --output data/results.xml

# Without fixture judgments, semantic checks remain in review
npm run simulate -- --scenario RF-001

# Resume an interrupted execution using its saved ID and the same database
npm run simulate -- --resume EXECUTION_ID
```

The default database is `data/windtunnel.sqlite`; choose another with `--db PATH`. Reports include before/after state, checks, tool results, fault events, refunds and execution IDs. `data/` is ignored by Git. Repetitions use independent shop state. These are scripted fixture agents. `--fixture-judges` injects synthetic judgments and does not establish real model accuracy or injection detection.

Exit codes: **0** for passing runs; **1** for agent failures, execution errors, cancellation or unresolved review; **2** for invalid arguments/setup errors. `--allow-review` explicitly permits unresolved reviews in the exit code. Expected negative fixture behavior still exits 1: a detected double refund is a successful workbench regression test but a failed agent run.

## Verification and current limits

`npm run test:runner` exercises all 40 scenarios and runner lifecycle. `npm run test:api` covers real Fastify requests, sessions/CSRF/ownership, imports, traversal, redaction, actual runner work, cancellation, restart and SSE replay. `npm run test:web` builds the production UI and uses Chromium to check stored attack payloads, launch/inspect/export/reload flows, narrow layouts and keyboard controls. Browser tests require the Chromium installation above; they use temporary databases and no paid services. Screenshots are saved under ignored `data/qa/`.

`npm test` builds the frontend and runs the entire suite. Provider, egress and injection-detector capabilities remain visibly TODO. `npm run test:release` fails while any required capability remains unimplemented.

SQLite checkpoints atomically preserve simulated state, ledger and the next step. Resume does not blindly replay a committed step; optimistic revisions reject competing checkpoint updates. Suites run through a persistent single-process queue, with a database process lock and graceful resume. Budget reservation is currently an in-process utility, not a durable cloud dispatch system. The runner bounds scripted tool steps and retries; bounded inference, multi-worker leasing and durable cloud budgets remain future work.

A separate committed-state oracle reconciles actual refund rows, balances, authorization evidence and ledger events. It can detect excess/duplicate writes even if the mock shop's check flags were cleared. Attempted violations remain recorded separately when the mock shop blocks a write.

Real model/agent adapters, Laya/Jev providers, outbound network policy, injection-detector integration, scenario editing/import and human adjudication remain pending. Ordinary runner use does not promote fixture metadata into trusted semantic judgments. No payments, cloud inference or arbitrary tools are available to the scripted agent. The local API/browser checks establish the implemented boundaries; they are not a complete security or model-accuracy assessment.

Design notes are locally excluded by the repository's existing `.git/info/exclude`; that setting is preserved. Source, tests and this README are versioned. Commits remain local.
