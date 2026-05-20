# Implementation Plan: cap-agent-tool-loop

## Overview

Add a per-turn iteration cap to `Agent.runLoop` in `deepseek-agent/agent.ts` so a runaway tool-calling model cannot spin indefinitely. The cap is resolved once at module load from `AGENT_MAX_ITERATIONS` (default 25, range 1–1000), held for the lifetime of each `Agent` instance, and enforced inside the existing `tool_calls` branch of `runLoop`. When the cap fires, `Agent.sendMessage` resolves to a fixed `Cap_Reply` string and emits a new `loop_cap` event into the JSONL history; below-cap behaviour stays byte-for-byte identical to today.

The implementation is intentionally minimal: a small helper + one branch in `agent.ts`, one new union member in `log/logger.ts`, one comment line in `.env.example`. Tests live alongside source as `*.test.ts` and run with `bun test`. Property-based tests use `fast-check` (added as a devDependency); each property is one `fc.assert(...)` call tagged with the workflow's required `// Feature: cap-agent-tool-loop, Property N: …` comment. A test-only `agent.legacy.ts` fixture provides the pre-feature `runLoop` reference for Property 4.

The implementation language is TypeScript, matching the existing project (Bun + TypeScript, `bun test`).

## Tasks

- [x] 1. Extend logging types and add `fast-check` for property-based testing
  - [x] 1.1 Add `fast-check` as a devDependency
    - Edit `deepseek-agent/package.json` to add `fast-check` (recent stable version) under `devDependencies`
    - Run `bun install` in `deepseek-agent/` to populate `bun.lock`
    - _Requirements: testing infrastructure for Properties 1–10_

  - [x] 1.2 Extend `EventKind` union with `"loop_cap"`
    - Edit `log/logger.ts`: add `| "loop_cap"` as a new member of the `EventKind` union, alongside the existing seven kinds
    - Do not change `HistoryEntry`, `appendHistory`, or `readRecentHistory` — `meta: Record<string, unknown>` already accommodates `{ max_iterations, model }`
    - _Requirements: 4.1_

  - [ ]* 1.3 Smoke test that a `loop_cap` history entry round-trips through `appendHistory`
    - **Validates: Requirement 4.1**
    - Add a Bun test (e.g. in a new `log/logger.test.ts`) that calls `appendHistory({ ts, kind: "loop_cap", source: "telegram", text: "⚠️ Agent gave up after 25 iterations.", meta: { max_iterations: 25, model: "deepseek-chat" } })` against a temp `HISTORY_FILE`, reads the resulting line back, and asserts `JSON.parse` yields the same object shape including `kind === "loop_cap"`
    - Use a per-test temporary file path so the real `log/history.jsonl` is untouched
    - _Requirements: 4.1_

- [x] 2. Implement the iteration cap in `Agent.runLoop`
  - [x] 2.1 Add `resolveMaxIterations` and the module-level `RESOLVED_MAX_ITERATIONS` constant
    - Edit `deepseek-agent/agent.ts`: at module top (above `class Agent`), add the constants `DEFAULT_MAX_ITERATIONS = 25`, `MAX_ITERATIONS_LOWER_BOUND = 1`, `MAX_ITERATIONS_UPPER_BOUND = 1000`
    - Add the `resolveMaxIterations(): number` helper exactly as specified in design "Components and Interfaces → resolveMaxIterations()": read `process.env.AGENT_MAX_ITERATIONS`, return default for `undefined`/empty/whitespace-only, reject non-`/^\d+$/` values after `trim()` with one `console.warn` containing the literal `AGENT_MAX_ITERATIONS` and the rejected raw value, reject out-of-range integers (including 0, negative, >1000) with the same warning shape, otherwise return `parseInt(trimmed, 10)`
    - Export both `resolveMaxIterations` and `RESOLVED_MAX_ITERATIONS` so tests can import them
    - Assign `RESOLVED_MAX_ITERATIONS = resolveMaxIterations()` once at module load (so the warning, if any, fires at process start, not per-instance)
    - _Requirements: 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ]* 2.2 Property test for `resolveMaxIterations` purity
    - **Property 1: `resolveMaxIterations` is a pure function of `AGENT_MAX_ITERATIONS`**
    - **Validates: Requirements 1.3, 2.1, 2.2, 2.3**
    - Create `deepseek-agent/agent.test.ts` with the workflow tag `// Feature: cap-agent-tool-loop, Property 1: …`
    - Generator: `fc.oneof(fc.constant(undefined), whitespace-only string, valid digit string for [1, 1000], invalid string with non-digits, "0", negative integer string, integer > 1000)`; for each, set `process.env.AGENT_MAX_ITERATIONS` (or delete it for `undefined`), call `resolveMaxIterations()`, and assert: returns parsed integer when valid, returns 25 in every other case
    - Run via `fc.assert(prop, { numRuns: 1000 })` (pure function, cheap)
    - Restore the original env value at the end of each shrink iteration
    - _Requirements: 1.3, 2.1, 2.2, 2.3_

  - [ ]* 2.3 Property test for the resolver's stderr warning on invalid input
    - **Property 2: Invalid `AGENT_MAX_ITERATIONS` emits exactly one stderr warning**
    - **Validates: Requirement 2.4**
    - Add to `deepseek-agent/agent.test.ts` with tag `// Feature: cap-agent-tool-loop, Property 2: …`
    - Generator: non-empty, non-whitespace-only strings that fail Property 1's parsing rule (non-digit chars, "0", negative, > 1000)
    - Spy on `console.warn` (record calls into an array, restore at end), call `resolveMaxIterations()` exactly once, and assert: spy was called exactly once, the call's joined message contains both the literal `AGENT_MAX_ITERATIONS` substring and the rejected raw string `v` as a substring
    - Run via `fc.assert(prop, { numRuns: 1000 })`
    - _Requirements: 2.4_

  - [x] 2.4 Add the `maxIterations` field on `Agent` and the cap branch in `runLoop`
    - Edit `deepseek-agent/agent.ts`: declare `private readonly maxIterations: number;` on the `Agent` class and assign `this.maxIterations = RESOLVED_MAX_ITERATIONS` in the constructor (so any post-construction mutation of `process.env` does not affect the value)
    - Inside `runLoop`'s existing `if (message.tool_calls && message.tool_calls.length > 0)` branch, before the `for (const toolCall of message.tool_calls)` loop, insert the cap check exactly as specified in design "Components and Interfaces → Cap branch in runLoop":
      - `if (attempt >= this.maxIterations) { ... }`
      - Build `capReply = ⚠️ Agent gave up after ${this.maxIterations} iterations.`
      - `try { await this.emit({ kind: "loop_cap", source, text: capReply, meta: { max_iterations: this.maxIterations, model } }); } catch { /* swallow */ }`
      - `return capReply;` immediately, before any tool dispatch
    - Do not add `Cap_Reply` to `this.history`; only the assistant message (already pushed above the branch) stays in history
    - Do not change the existing `retry`, `tool_call`, `tool_result`, or `model_reply` emissions, their ordering, or any other code in `runLoop`
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 3.1, 3.2, 3.5, 3.6, 4.2, 4.3, 4.4, 4.5, 4.6, 5.4, 6.1, 6.3, 6.4_

  - [ ]* 2.5 Property test for `Cap_Reply` exact formatting
    - **Property 5: `Cap_Reply` formatting is exact and round-trippable**
    - **Validates: Requirement 3.2**
    - Add to `deepseek-agent/agent.test.ts` with tag `// Feature: cap-agent-tool-loop, Property 5: …`
    - Generator: `fc.integer({ min: 1, max: 1000 })`
    - For each `N`, build the cap-reply string the same way the implementation does and assert: equals the literal `⚠️ Agent gave up after ${N} iterations.`, contains the substring `Agent gave up after ` followed by `N` followed by ` iterations.`, has no surrounding whitespace, and the regex `/^⚠️ Agent gave up after (\d+) iterations\.$/` extracts a capture group whose `parseInt(_, 10)` equals `N`
    - Run via `fc.assert(prop, { numRuns: 1000 })` (pure function, cheap)
    - _Requirements: 3.2_

- [x] 3. Build the test-only `agent.legacy.ts` reference fixture for Property 4
  - [x] 3.1 Extract the pre-feature `runLoop` into `agent.legacy.ts`
    - Create `deepseek-agent/agent.legacy.ts` exporting a function (or class) that runs the **pre-feature** loop body — identical to the current `runLoop` shape but with **no** cap branch, no `loop_cap` emission, and no `maxIterations` field
    - The fixture must accept the same dependencies as the new `Agent.runLoop` for parity in tests: an OpenAI-shaped client (`chat.completions.create`), an in-memory history array reference, an `emit`-shaped log function, and a `notifyUser`-shaped callback
    - Mirror the existing emission set and ordering exactly (`retry` for `attempt > 1`, then API call, then push assistant, then tool dispatch with `tool_call`/`tool_result`, or `model_reply` + return on no tool calls)
    - This file is test-only; do not import it from `index.ts`, `agent.ts`, or any production path
    - _Requirements: 6.1, 6.2 (used as the reference for Property 4)_

- [ ] 4. Property tests for cap behaviour in `agent.test.ts`
  - [ ]* 4.1 Property test that the cap value is fixed and the iteration counter is per-call
    - **Property 3: The cap is fixed for the lifetime of an Agent instance, and the iteration counter is scoped per call**
    - **Validates: Requirements 1.1, 1.6, 2.5, 2.7, 5.4**
    - Add to `deepseek-agent/agent.test.ts` with tag `// Feature: cap-agent-tool-loop, Property 3: …`
    - Construct one `Agent` instance backed by a `MockOpenAI` whose script is reset between calls, then run a generated sequence of `sendMessage` calls; mutate `process.env.AGENT_MAX_ITERATIONS` between calls and assert: every call observes the same `maxIterations` (the construction-time value), and the iteration counter on call B starts at zero regardless of how many iterations call A performed (verified via the recorded `retry` count and the cap firing exactly at the configured `N` on each call)
    - Run via `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 1.1, 1.6, 2.5, 2.7, 5.4_

  - [ ]* 4.2 Property test that below-cap behaviour matches the pre-feature implementation
    - **Property 4: Below-cap behaviour matches the pre-feature implementation**
    - **Validates: Requirements 1.5, 6.1, 6.2**
    - Add to `deepseek-agent/agent.test.ts` with tag `// Feature: cap-agent-tool-loop, Property 4: …`
    - Generator: `(N, K, mock-completion-sequence)` with `1 ≤ K ≤ N ≤ 1000`; the mock returns `tool_calls` on iterations `1..K-1` and a final assistant reply (no `tool_calls`) on iteration `K`
    - Drive both implementations (new `Agent.runLoop` and the `agent.legacy.ts` fixture) with the **same** `MockOpenAI`, `mockLogFn`, and starting history; assert deep-equality of: the recorded event trace (kinds, sources, texts, meta, ordering), the final `history` array, and the resolved value
    - Run via `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 1.5, 6.1, 6.2_

  - [ ]* 4.3 Property test that the cap halts the loop at iteration `N` and `sendMessage` resolves to `Cap_Reply`
    - **Property 6: When the cap fires, the loop halts at iteration N and `sendMessage` resolves to `Cap_Reply`**
    - **Validates: Requirements 1.2, 1.4, 3.1, 3.5, 5.2, 5.5**
    - Add to `deepseek-agent/agent.test.ts` with tag `// Feature: cap-agent-tool-loop, Property 6: …`
    - Generator: `(N, source, mock-tool-calls-shape)` where `N ∈ [1, 1000]`, `source ∈ {"telegram", "vox", arbitrary string}`, and the mock returns at least one `tool_call` on every iteration
    - Construct an `Agent` whose `maxIterations === N` (override the field directly via a test seam, or set the env var before module re-import); assert: `chat.completions.create` is called exactly `N` times, the awaited `sendMessage` resolves (does not reject) to `⚠️ Agent gave up after ${N} iterations.`, the count of `model_reply` events is `0`, and the count of `tool_call` and `tool_result` events for the capping iteration is `0`
    - Run via `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 1.2, 1.4, 3.1, 3.5, 5.2, 5.5_

  - [ ]* 4.4 Property test that the capping assistant message is the last entry in history
    - **Property 7: The capping assistant message is appended to history before `sendMessage` returns**
    - **Validates: Requirement 3.6**
    - Add to `deepseek-agent/agent.test.ts` with tag `// Feature: cap-agent-tool-loop, Property 7: …`
    - Generator: a random assistant message `M` with arbitrary `content` and arbitrary non-empty `tool_calls`, returned by the mock on the iteration that triggers the cap
    - Assert: `this.history.at(-1)` deep-equals `M` (same `role`, `content`, and `tool_calls`); the `Cap_Reply` string does not appear as an additional history entry
    - Run via `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 3.6_

  - [ ]* 4.5 Property test that the `loop_cap` history entry records the cap event faithfully
    - **Property 8: The `loop_cap` history entry faithfully records the cap event**
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5**
    - Add to `deepseek-agent/agent.test.ts` with tag `// Feature: cap-agent-tool-loop, Property 8: …`
    - Generator: `(N, source, model)` and a `logFn` variant that delays its resolution by `T` ms before resolving
    - Assert: exactly one event with `kind === "loop_cap"` per turn; `source` equals the original `source` argument; `text` equals the value returned by `sendMessage`; `meta.max_iterations === N`; `meta.model === M` (the model passed to the most recent `chat.completions.create`); and `sendMessage` resolves at or after `T` ms (i.e. it awaits the `logFn` invocation)
    - Run via `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 4.2, 4.3, 4.4, 4.5_

  - [ ]* 4.6 Property test that a logging failure on the `loop_cap` append does not propagate
    - **Property 9: A logging failure on the `loop_cap` append does not propagate**
    - **Validates: Requirement 4.6**
    - Add to `deepseek-agent/agent.test.ts` with tag `// Feature: cap-agent-tool-loop, Property 9: …`
    - Generator: `logFn` variants of the form `{ syncThrow, returnRejectedPromise, delayedReject }`, each parameterised by an arbitrary error
    - Assert: with that `logFn` installed, the awaited `sendMessage` for the cap-triggering call still resolves (does not reject) to `Cap_Reply` for the configured `N`; non-`loop_cap` events are out of scope (do not assert on their behaviour)
    - Run via `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 4.6_

  - [ ]* 4.7 Property test that event ordering on every post-first iteration is `retry` first, with cap tail `..., retry, loop_cap`
    - **Property 10: Event ordering on every post-first iteration**
    - **Validates: Requirements 6.3, 6.4**
    - Add to `deepseek-agent/agent.test.ts` with tag `// Feature: cap-agent-tool-loop, Property 10: …`
    - Generator: `(N, mock-sequence)` covering both cap-firing and below-cap turns
    - Assert: count of `retry` events equals `iterations_performed - 1` (so `N - 1` when the cap fires; `K - 1` when a final reply is produced on iteration `K`); each `retry` for iteration `i ≥ 2` immediately precedes that iteration's first non-`retry` event (`tool_call`, `model_reply`, or `loop_cap`); on the capping iteration the trace tail is `..., retry, loop_cap` for `N ≥ 2` or just `loop_cap` for `N === 1`, with no `tool_call`, `tool_result`, or `model_reply` between the capping iteration's `retry` and `loop_cap`
    - Run via `fc.assert(prop, { numRuns: 100 })`
    - _Requirements: 6.3, 6.4_

- [x] 5. Checkpoint — agent + logger work end-to-end
  - Ensure `bun test deepseek-agent/agent.test.ts log/logger.test.ts` runs cleanly with all property tests passing (those marked `*` are optional but should be green when implemented). Ensure all tests pass, ask the user if questions arise.

- [x] 6. Document the new env var and add example-based Telegram wiring tests
  - [x] 6.1 Document `AGENT_MAX_ITERATIONS` in `.env.example`
    - Append to `deepseek-agent/.env.example` exactly one commented line documenting the optional variable, matching the file's existing style for optional vars: `# AGENT_MAX_ITERATIONS=25  # Optional. Max tool-loop iterations per turn (1-1000). Default 25.`
    - Do not change any other line in the file
    - _Requirements: 2.1, 2.2 (operator-facing documentation of the override mechanism)_

  - [ ]* 6.2 Example-based test: `Cap_Reply` is delivered to Telegram via `MessageBatcher.enqueue`
    - **Validates: Requirements 3.3, 5.1**
    - Create `deepseek-agent/index.test.ts` (example-based, not property-based — this is wiring, not behaviour-over-input)
    - Set up a fake `Agent` whose `sendMessage` returns `⚠️ Agent gave up after 25 iterations.`, a fake `MessageBatcher` that records `enqueue(chatId, text)` calls, and exercise the Telegram `message:text` handler path with a mock `ctx` containing a fixed `chat.id`
    - Assert: `batcher.enqueue` is called exactly once with the same `chatId` from the user message and `text === Cap_Reply`; `appendHistory` is called once with `kind === "telegram_out"` and `text === Cap_Reply`
    - _Requirements: 3.3, 5.1_

  - [ ]* 6.3 Example-based test: enqueue failure for `Cap_Reply` falls into the existing `catch (error: any)` path without crashing
    - **Validates: Requirement 3.4**
    - Add to `deepseek-agent/index.test.ts`
    - Configure the fake `MessageBatcher` so `enqueue` throws synchronously the first time it is called for the cap reply; assert: the error is caught, the process does not exit (no `process.exit` is invoked from the handler), and a subsequent call to the handler with a different message is still serviced (i.e. the handler remains live)
    - _Requirements: 3.4_

- [x] 7. Final checkpoint — full test suite green
  - Ensure `bun test` from the repo root (or `bun test` inside `deepseek-agent/`) passes for every non-optional task and every optional `*` task that was implemented. Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; they are the property tests, the `loop_cap` smoke test, and the Telegram wiring example tests. The `agent.legacy.ts` fixture in task 3.1 is required for the optional Property 4 test, so skip 3.1 if 4.2 is also skipped.
- Each property test uses a hand-rolled `MockOpenAI` and `mockLogFn` — no real DeepSeek calls, no network. Tests live alongside source as `*.test.ts` and run via `bun test`.
- Property tests P1, P2, P5 use `numRuns: 1000` (pure functions, cheap); P3, P4, P6, P7, P8, P9, P10 use `numRuns: 100` (drive a mock loop).
- Each property test is tagged at the top with the workflow's required `// Feature: cap-agent-tool-loop, Property N: …` comment.
- The cap branch goes inside the existing `if (message.tool_calls && message.tool_calls.length > 0)` branch of `runLoop`, after the assistant message is pushed to history and before any tool dispatch — this preserves Requirement 3.6 (history ends with the capping assistant message) and Requirement 6.4 (no `tool_call`/`tool_result`/`model_reply` for the capping iteration) without any new branches outside the loop.
- No changes to `index.ts`, `batcher.ts`, `tools.ts`, or `vox/index.ts` — `Cap_Reply` is delivered through the existing `Promise<string>` resolution path of `Agent.sendMessage`, exercising the same `batcher.enqueue` wiring as a normal final reply.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "6.1"] },
    { "id": 1, "tasks": ["1.3", "2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["2.3"] },
    { "id": 4, "tasks": ["2.4"] },
    { "id": 5, "tasks": ["2.5", "6.2"] },
    { "id": 6, "tasks": ["4.1", "6.3"] },
    { "id": 7, "tasks": ["4.2"] },
    { "id": 8, "tasks": ["4.3"] },
    { "id": 9, "tasks": ["4.4"] },
    { "id": 10, "tasks": ["4.5"] },
    { "id": 11, "tasks": ["4.6"] },
    { "id": 12, "tasks": ["4.7"] }
  ]
}
```
