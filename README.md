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

The UI launches authored or model-driven refund cases, repeats suites, streams progress, filters outcomes, inspects conversations/checks/before-after state, and downloads JSON/JUnit reports. Saved suites survive restart. Scenario copies are immutable and owner-scoped; previous suites keep their original version. Judge lab appends human reviews alongside original judgments, with deterministic failures taking precedence. Baseline comparisons match scenario IDs and repetition indices. Use synthetic judgments explicitly for fixture regression work; real semantic providers remain human-gated until calibrated.

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
| `POST /api/executions/:id/reviews` | Append a semantic human label without changing original checks |
| `GET /api/reviews` | Operational review counts and matrix; no accuracy claim |
| `POST /api/scenarios` | Create an immutable copy with reviewed messages/actions |
| `POST /api/providers`, `POST /api/providers/test` | Explicit provider roles/configuration and synthetic availability/tool probes |
| `GET /api/suites/:id/compare?baseline=ID` | Compare owned suites over matching scenario/repetition pairs |
| `GET /api/suites/:id/export?format=json\|junit` | Inert attachment export |
| `GET /api/artifacts/:id` | Owned attachment with canonical-path checks |

Suite requests accept `scenarioPack: "refunds-v1"`, an `agentId` (`fixture-safe` or a configured provider), `repeats: 1..10`, optional unique `scenarioIds`, and optional `fixtureJudges` (default false). Optional `judgeProviderId`, `guardProviderId`, `baselineId` and `cloudBudgetMicros` are explicit trusted configuration. A suite is capped at 400 executions; each owner may have eight queued/running suites. `fixture-safe` replays authored actions, including deliberate mistakes, rather than guaranteeing safe agent behavior.

## Real providers and review

In **Settings**, configure an endpoint origin, model/revision, context limit, network mode and allowed roles. Credentials use server-side `AW_*` environment references; never paste an actual key into a provider field. **Probe availability** performs discovery and, for agent roles, a synthetic structured-tool probe. Discovery alone does not prove tool calling. The installed Qwen smoke responded with JSON-looking prose rather than structured calls; the app preserved that reply as text and created no refund.

The bounded agent loop supports Ollama/Chat Completions and the Responses function-call protocol, executing only mock-shop tools. Pending calls, tool outputs and conversation history are checkpointed. Resume requires the same adapter. Unknown tools, malformed arguments, response/context limits and deadlines fail closed. A local Chat Completions judge can supply validated evidence-linked diagnostics, but its self-reported confidence does not authorize a pass.

System One supports choice, score and noul validation, exact local preflight, model-revision checks and evidence-scoped caching. Laya/Jev probability distributions and output usage are preserved. Hosted providers require explicit role consent, TLS, known pricing and a reserved per-suite budget. Reservations persist in SQLite; requests with uncertain billing retain their reservation. No hosted call is made by ordinary tests or smoke scripts. Jev remains blocked for live dispatch until a matching exact-token preflight is supplied; no hosted compatibility or account availability is claimed.

Human reviews can resolve `message_truth` and `injection`; they cannot edit business checks. Original outcomes remain exported alongside human-adjudicated outcomes. Review counts are operational observations, not held-out calibration. Automatic real-provider acceptance remains disabled.

### Laya sidecar (Windows, Python 3.12)

```powershell
Push-Location services/laya
uv venv --python 3.12
uv pip sync requirements.lock --require-hashes
Pop-Location

# Explicit data-only download; runtime never downloads models/code
services/laya/.venv/Scripts/python.exe services/laya/setup_model.py --revision e929ae5cf69bc34259cd2f95c9e91145b818b1f0
npm run test:laya
npm run start:laya
# In another terminal:
npm run smoke:laya
npm run smoke:local
```

The sidecar uses `laya==0.4.15` with hash-locked dependencies. Checkpoint JSON/safetensors assets live under ignored `data/models/`; a hash manifest pins model and tokenizer revisions. Startup verifies the manifest, uses local files and offline flags, and binds to loopback port 8000. `AW_LAYA_MODEL_DIR`, `AW_LAYA_PORT` and `AW_LAYA_DEVICE` customize those trusted settings. The default is CPU. Input preflight uses the pinned runtime's actual per-question sequence builder and rejects state, instruction or label truncation before inference.

Configure a System One provider with model `laya-typed-decisions`, endpoint `http://127.0.0.1:8000`, model/tokenizer revision `e929ae5cf69bc34259cd2f95c9e91145b818b1f0`, context 1024 and judge/guard roles. The Windows smoke verified loading, actual token counts, typed inference and overflow rejection. It did not establish accuracy: the checkpoint emits a calibration warning and a deliberately contradictory sample received an unreliable label, so the run stays review-gated. [Model card](https://huggingface.co/convaiinnovations/laya-typed-decisions), [runtime source](https://github.com/NandhaKishorM/laya), [System One contract](https://docs.typesafe.ai/api/system-one), [Responses function calls](https://developers.openai.com/api/docs/guides/function-calling).

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

`npm test` builds the frontend and runs the entire contract suite, including providers, egress and injection isolation. `npm run test:release` additionally fails on any missing adapter/capability. Passing these contracts is an implementation gate, not a complete deployment/accuracy certification. Python HTTP/manifest tests are separate (`npm run test:laya`); real models are explicitly opt-in smoke tests.

SQLite checkpoints atomically preserve simulated state, ledger and the next step. Resume does not blindly replay a committed step; optimistic revisions reject competing checkpoint updates. Suites run through a persistent single-process queue, with a database process lock and graceful resume. Inference turns, tool steps, retries, response bytes, scan coverage and deadlines are bounded. Persistent hosted reservations and spending survive process restarts. Multiple simultaneous workers remain outside the supported single-process architecture.

A separate committed-state oracle reconciles actual refund rows, balances, authorization evidence and ledger events. It can detect excess/duplicate writes even if the mock shop's check flags were cleared. Attempted violations remain recorded separately when the mock shop blocks a write.

Remaining external release work includes held-out human-labeled calibration, explicitly budgeted live Jev compatibility, network-disabled system-level verification, and broader long-running/concurrent/crash evaluation. Arbitrary scenario/control-metadata imports, SaaS and real payment connections remain unsupported by design. Ordinary runner use does not promote fixture metadata into trusted judgments. The local API/browser checks establish the implemented boundaries; they are not a complete security or model-accuracy assessment.

Design notes are locally excluded by the repository's existing `.git/info/exclude`; that setting is preserved. Source, tests and this README are versioned. Commits remain local.
