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
npm run typecheck
npm test
npm audit
```

No model, Python environment, API key or paid service is needed for scripted runs. Dependencies are pinned in `package-lock.json`. Python is reserved for the future Laya inference sidecar; the starter `main.py` is unused by the simulator.

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

`npm run test:runner` exercises all 40 scenarios, cancellation, isolation, retry/turn limits, checkpoint conflicts, recovery after a committed timeout, and integer budget reservations. `npm test` also executes fixture, CLI and harness checks, leaving other application capabilities visibly TODO. `npm run test:release` fails while any required capability remains unimplemented.

SQLite checkpoints atomically preserve simulated state, ledger and the next step. Resume does not blindly replay a committed step; optimistic revisions reject competing checkpoint updates. Budget reservation is currently an in-process utility, not a durable cloud dispatch system. The runner bounds scripted tool steps and retries; inference timeouts, worker leases and durable cloud budgets remain future work.

A separate committed-state oracle reconciles actual refund rows, balances, authorization evidence and ledger events. It can detect excess/duplicate writes even if the mock shop's check flags were cleared. Attempted violations remain recorded separately when the mock shop blocks a write.

The web UI, local HTTP API, real agent adapters, Laya/Jev providers, network policy enforcement and browser security implementation are still pending. Ordinary runner use does not promote fixture metadata into trusted semantic judgments. No payments, cloud inference or arbitrary tools are available to the scripted agent.

Design notes are locally excluded by the repository's existing `.git/info/exclude`; that setting is preserved. Source, tests and this README are versioned. Commits remain local.
