# Design Document — `cap-agent-tool-loop`

## Overview

`Agent.runLoop` in `deepseek-agent/agent.ts` is currently an unbounded `while (true)`. A model that keeps emitting `tool_calls` will spin until the DeepSeek API errors, burning credits and host resources with no clear signal to the user. This feature adds a **per-turn iteration cap** that:

- Defaults to 25, configurable via the `AGENT_MAX_ITERATIONS` env var with a valid range of 1–1000.
- Is resolved **once** at first `Agent` construction and held for the lifetime of that `Agent` instance.
- Halts the loop **before** dispatching the next batch of tool calls when the cap is reached, returning a fixed `Cap_Reply` string `⚠️ Agent gave up after N iterations.` through the normal (non-throwing) return path.
- Records cap termination as a new `EventKind` value `"loop_cap"` in `log/logger.ts`, with `meta.max_iterations` and `meta.model` so the daily self-optimiser can see it.
- Preserves all existing event ordering and history mutations when the cap is **not** reached: the loop must remain byte-for-byte identical for sub-cap turns.

The change is intentionally minimal: a few lines added to `Agent`, one new union member in `EventKind`, one line in `.env.example`. No refactor.

### Goals

- Cap the loop so a runaway tool-calling model cannot burn unbounded credits.
- Keep the feature observable in the JSONL history so the optimiser can detect and reason about it.
- Apply uniformly to every input surface that goes through `Agent.sendMessage` (Telegram, vox, anything else).
- Stay invisible when the loop completes within the cap.

### Non-Goals

- No retry/backoff or per-tool timeout changes.
- No changes to tool dispatch, history shape (other than the new `EventKind`), or the `MessageBatcher`.
- No changes to `index.ts` Telegram routing or to `vox`'s subprocess supervision.
- No mid-turn re-reading of the env var, no per-call override, no UI to surface remaining iterations.

## Architecture

The cap lives inside `Agent` and is enforced inside `runLoop`. Everything outside `Agent` keeps using the existing surface: `Agent.sendMessage` returns a string; `index.ts` enqueues that string into `MessageBatcher`; `vox` awaits the resolved value of any in-process call. No caller needs to know about the cap.

### Flow when the cap is NOT reached (unchanged from today)

```
sendMessage(text, source, chatId)
  ├─ history.push(user)
  ├─ emit telegram_in / vox_in
  └─ runLoop()
       loop:
         attempt++
         if attempt > 1: emit retry
         resp = chat.completions.create(...)
         history.push(assistant)
         if resp.tool_calls?.length > 0:
            for each tool_call:
              emit tool_call → run tool → history.push(tool) → emit tool_result
            continue
         else:
            emit model_reply
            return resp.content
```

### Flow when the cap IS reached

```
sendMessage(text, source, chatId)
  ├─ history.push(user)
  ├─ emit telegram_in / vox_in
  └─ runLoop()
       loop:
         attempt++
         if attempt > 1: emit retry             ← still emitted for the capping iter
         resp = chat.completions.create(...)
         history.push(assistant)                ← assistant msg that triggered cap
         if resp.tool_calls?.length > 0:
            if attempt >= maxIterations:
              capReply = `⚠️ Agent gave up after ${maxIterations} iterations.`
              try { emit loop_cap (text=capReply, meta={max_iterations, model}) }
              catch { /* swallow; do not throw */ }
              return capReply                   ← no tool_call/tool_result/model_reply
            ... run tools as before ...
         else:
            emit model_reply
            return resp.content
```

The decision point is: after the assistant message has been **appended to history** but **before any tool is dispatched**, check whether (a) tool_calls are present and (b) the iteration counter has reached the cap. If both, emit `loop_cap` and return `Cap_Reply` directly.

This ordering is what gives Requirement 6.4 (`retry` is emitted for the capping iteration; no `tool_call`/`tool_result`/`model_reply` for it) and Requirement 3.6 (the assistant message that triggered the cap is in history when we return) without any new branches outside the loop.

### Why the cap check goes after the API call, not before

A tempting alternative is to check `attempt > maxIterations` at the top of the loop, before calling the API. That would avoid one API call but would violate Requirement 3.6: the user message would have been appended to history, but the assistant message that "tried to call tools one more time" would not, leaving the next call to `sendMessage` looking at a history that ends in a user turn. By checking after the response is appended, we keep history coherent.

It also matches the spirit of "cap = N iterations performed". If `Max_Iterations = 25`, the agent is allowed to perform 25 think/tool-call cycles. The 25th can be a normal final reply. Only if the 25th still wants to call tools do we stop and emit `Cap_Reply`.

## Components and Interfaces

### `deepseek-agent/agent.ts` — primary changes

Two additions, both inside `Agent`:

1. **Resolved cap value.** A private readonly numeric field `private readonly maxIterations: number`, set in the constructor by calling a small helper `resolveMaxIterations()` (defined as a module-level function in the same file). The field is fixed for the lifetime of the instance; we do not re-read `process.env.AGENT_MAX_ITERATIONS` later. The helper is also called eagerly at module load time so the warning, if any, prints once at process start before the first `sendMessage` is invoked.

2. **Cap branch in `runLoop`.** Inside the existing `if (message.tool_calls && message.tool_calls.length > 0)` branch, add a guarded early-return at the top of the branch:

   ```ts
   if (attempt >= this.maxIterations) {
     const capReply = `⚠️ Agent gave up after ${this.maxIterations} iterations.`;
     try {
       await this.emit({
         kind: "loop_cap",
         source,
         text: capReply,
         meta: { max_iterations: this.maxIterations, model },
       });
     } catch {
       // Logging failure must not propagate; Cap_Reply still returned.
     }
     return capReply;
   }
   ```

   The check uses `>=` because `attempt` was already incremented at the top of the loop iteration. So when `maxIterations === 25`, the cap fires on the 25th iteration if and only if the model still wants to call tools.

`runLoop` retains its existing `attempt` counter (renamed conceptually to "iteration counter" but the local variable name does not need to change) and existing event emissions. The counter is a function-local `let attempt = 0`, so it is naturally scoped per call (Requirement 1.6).

The existing `retry` event for `attempt > 1` is emitted in its current position — at the top of the iteration body, before the API call. This is what makes Requirement 6.3 fall out for free: every iteration after the first, including the capping iteration, gets a `retry` event before any other action.

#### `resolveMaxIterations()` helper

A small module-level function at the top of `agent.ts`:

```ts
const DEFAULT_MAX_ITERATIONS = 25;
const MAX_ITERATIONS_LOWER_BOUND = 1;
const MAX_ITERATIONS_UPPER_BOUND = 1000;

function resolveMaxIterations(): number {
  const raw = process.env.AGENT_MAX_ITERATIONS;
  if (raw === undefined) return DEFAULT_MAX_ITERATIONS;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_MAX_ITERATIONS;

  // Strict ASCII digits only; reject "+5", "-5", "1.0", "5e2", "0x10", " 5 " (after trim).
  if (!/^\d+$/.test(trimmed)) {
    console.warn(
      `[agent] Ignoring invalid AGENT_MAX_ITERATIONS=${JSON.stringify(raw)}; using default ${DEFAULT_MAX_ITERATIONS}.`
    );
    return DEFAULT_MAX_ITERATIONS;
  }

  const n = Number.parseInt(trimmed, 10);
  if (n < MAX_ITERATIONS_LOWER_BOUND || n > MAX_ITERATIONS_UPPER_BOUND) {
    console.warn(
      `[agent] Ignoring out-of-range AGENT_MAX_ITERATIONS=${JSON.stringify(raw)} (must be ${MAX_ITERATIONS_LOWER_BOUND}-${MAX_ITERATIONS_UPPER_BOUND}); using default ${DEFAULT_MAX_ITERATIONS}.`
    );
    return DEFAULT_MAX_ITERATIONS;
  }
  return n;
}

// Resolve once at module load so the warning, if any, appears at startup —
// not once per Agent instance.
const RESOLVED_MAX_ITERATIONS = resolveMaxIterations();
```

The constructor then assigns `this.maxIterations = RESOLVED_MAX_ITERATIONS`. This satisfies Requirement 2.5 (evaluate exactly once) and Requirement 2.4 (warn on stderr referencing the literal `AGENT_MAX_ITERATIONS` and the rejected raw value) without per-instance side effects.

`console.warn` writes to stderr in both Node and Bun, satisfying Requirement 2.4's stderr clause.

### `log/logger.ts` — add `loop_cap` to `EventKind`

A single union extension:

```ts
export type EventKind =
  | "telegram_in"
  | "telegram_out"
  | "vox_in"
  | "model_reply"
  | "tool_call"
  | "tool_result"
  | "retry"
  | "loop_cap";
```

`HistoryEntry.meta` is already typed as `Record<string, unknown>` so `{ max_iterations: number; model: string }` fits without changing the type. We do not narrow `meta` per-kind: keeping the existing structural shape avoids touching every existing call site.

### `deepseek-agent/index.ts` — no changes needed

The Telegram handler already does:

```ts
const response = await agent.sendMessage(userMessage, "telegram", chatId);
await appendHistory({ ts: Date.now(), kind: "telegram_out", source: "telegram", text: response });
batcher.enqueue(chatId, response);
```

Because `Cap_Reply` is returned through the normal `Promise<string>` resolution path, the `try` block resolves successfully, the `catch` branch with `❌ Error from agent: …` is not entered, and `MessageBatcher.enqueue` is invoked exactly once with the cap message — which is exactly what Requirement 3.3 and Requirement 3.5 require. The `telegram_out` history entry is also emitted, mirroring the success path.

### `vox/index.ts` — no changes needed

vox does not currently call `Agent.sendMessage` directly; user input typed into the TUI is logged as `vox_in` for the optimiser's benefit but is not forwarded to a live agent in-process. If a future change wires vox to call `agent.sendMessage(..., "vox", ...)`, it will receive `Cap_Reply` as the resolved string by the same mechanism — satisfying Requirement 5.2 by construction. No vox-specific code is required by this feature.

### `deepseek-agent/.env.example` — documentation line

Add a single commented line documenting the new variable:

```dotenv
# AGENT_MAX_ITERATIONS=25  # Optional. Max tool-loop iterations per turn (1-1000). Default 25.
```

This mirrors the existing convention in the file (commented examples for optional vars).

## Data Models

The only schema change is in `EventKind`. The shape of a `loop_cap` history entry is:

```jsonc
{
  "ts": 1700000000000,            // unix ms, set by appendHistory caller
  "kind": "loop_cap",             // new EventKind value
  "source": "telegram" | "vox",   // original sendMessage source
  "text": "⚠️ Agent gave up after 25 iterations.",   // = Cap_Reply
  "meta": {
    "max_iterations": 25,          // integer Max_Iterations used for the turn
    "model": "deepseek-chat"       // model passed to chat.completions.create for the turn
  }
}
```

`HistoryEntry` retains the existing TypeScript type from `log/logger.ts`:

```ts
export interface HistoryEntry {
  ts: number;
  kind: EventKind;        // ← now includes "loop_cap"
  source: "telegram" | "vox";
  text: string;
  meta?: Record<string, unknown>;
}
```

No changes are needed to `appendHistory`, `readRecentHistory`, or the JSONL file format. Old entries remain readable; new `loop_cap` entries simply appear with the new kind.

### Conversation history mutation on cap

When the cap is reached on iteration `N`, the in-memory `this.history` ends in:

```
[…earlier turn entries…]
{ role: "user", content: "<user prompt that started the turn>" }
[…assistant + tool messages from iterations 1..N-1…]
{ role: "assistant", content: ..., tool_calls: [...] }   // the assistant message that triggered the cap
```

This is the verbatim assistant message returned by the model on iteration `N`, including its `tool_calls`. The `Cap_Reply` string is **not** added to `this.history`; it is only returned to the caller and logged via `appendHistory`. This satisfies Requirement 3.6 ("history ending with that assistant message") and matches what the existing code already does — we are simply choosing not to add a new `assistant` message for the synthetic `Cap_Reply`.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

The cap-agent-tool-loop feature is a good fit for property-based testing: the cap is a pure numeric invariant over a deterministic loop, the config resolver is a pure function of `process.env`, and "below-cap behaviour is unchanged from before" is a textbook model-based property. We test the agent loop against a mock OpenAI client and a mock `logFn`, so property runs are cheap (no network, no AWS).

The properties below are derived from the prework analysis. Several adjacent acceptance criteria were collapsed into single comprehensive properties to remove redundancy.

### Property 1: `resolveMaxIterations` is a pure function of `AGENT_MAX_ITERATIONS`

*For any* string `v` (or `undefined`) used as the value of `process.env.AGENT_MAX_ITERATIONS`, `resolveMaxIterations()` returns `n` when `v` is a decimal-digit string for an integer `n ∈ [1, 1000]` after trimming leading/trailing ASCII whitespace, and returns `25` (the default) in every other case (unset, empty, whitespace-only, non-digit, `0`, negative, non-integer, out-of-range).

**Validates: Requirements 1.3, 2.1, 2.2, 2.3**

### Property 2: Invalid `AGENT_MAX_ITERATIONS` emits exactly one stderr warning

*For any* string `v` of `AGENT_MAX_ITERATIONS` that is non-empty and not whitespace-only and does not satisfy the parsing rule of Property 1, calling `resolveMaxIterations()` once produces exactly one warning written to stderr whose text contains both the literal substring `AGENT_MAX_ITERATIONS` and the rejected raw string `v` as a substring.

**Validates: Requirements 2.4**

### Property 3: The cap is fixed for the lifetime of an Agent instance, and the iteration counter is scoped per call

*For any* sequence of `Agent.sendMessage` calls on a single `Agent` instance and *for any* mutations of `process.env.AGENT_MAX_ITERATIONS` performed after construction, every call observes the same `Max_Iterations` value (the one resolved at construction-time), and *for any* two consecutive calls A then B, the iteration counter at the start of B is independent of how many iterations A performed.

**Validates: Requirements 1.1, 1.6, 2.5, 2.7, 5.4**

### Property 4: Below-cap behaviour matches the pre-feature implementation

*For any* mock OpenAI sequence that produces a final assistant reply (zero `tool_calls`) on iteration `K` with `K ≤ Max_Iterations`, the new `Agent.runLoop` implementation produces:
- the same emitted event trace (kinds, sources, payloads, ordering, meta) as the pre-feature `runLoop`,
- the same final `this.history` mutation,
- the same resolved value (the model's final reply text),

as the pre-feature implementation given identical inputs and identical tool responses.

**Validates: Requirements 1.5, 6.1, 6.2**

### Property 5: `Cap_Reply` formatting is exact and round-trippable

*For any* integer `N ∈ [1, 1000]`, the `Cap_Reply` produced for that `N` equals the exact string `⚠️ Agent gave up after {N} iterations.` (where `{N}` is its base-10 decimal form, no thousands separators, no surrounding whitespace), and the regex `/^⚠️ Agent gave up after (\d+) iterations\.$/` extracts a capture group whose `parseInt(_, 10)` equals `N`.

**Validates: Requirements 3.2**

### Property 6: When the cap fires, the loop halts at iteration `N` and `sendMessage` resolves to `Cap_Reply`

*For any* `Max_Iterations` value `N ≥ 1`, *for any* mock OpenAI client that returns a non-empty `tool_calls` array on every iteration, and *for any* `source` value passed to `Agent.sendMessage` (including `"telegram"`, `"vox"`, and arbitrary other strings):
- the number of `chat.completions.create` calls performed during the turn equals exactly `N`,
- the awaited promise from `Agent.sendMessage` resolves (it does not reject) to the value `⚠️ Agent gave up after {N} iterations.`,
- the count of `model_reply` events emitted for the turn is `0`,
- the count of `tool_call` and `tool_result` events emitted for the iteration on which the cap fires is `0`.

**Validates: Requirements 1.2, 1.4, 3.1, 3.5, 5.2, 5.5**

### Property 7: The capping assistant message is appended to history before `sendMessage` returns

*For any* assistant message `M` (with arbitrary `content` and arbitrary non-empty `tool_calls`) returned by the mock model on the iteration that triggers the cap, the last entry of `this.history` after `Agent.sendMessage` resolves equals `M` verbatim — same `role`, same `content`, same `tool_calls`. The synthetic `Cap_Reply` string is **not** added as an additional history entry.

**Validates: Requirements 3.6**

### Property 8: The `loop_cap` history entry faithfully records the cap event

*For any* cap-triggering call (`N`, `source`, model name `M` resolved from `DEEPSEEK_MODEL_BASE`):
- exactly one event with `kind === "loop_cap"` is emitted via `logFn` per turn,
- that event's `source` equals the original `source` argument passed to `Agent.sendMessage`,
- that event's `text` equals the value resolved by the same `Agent.sendMessage` call,
- `meta.max_iterations === N`,
- `meta.model === M`,
- and `Agent.sendMessage` awaits completion of the `logFn` invocation before resolving (a `logFn` that resolves after `T` ms causes `sendMessage` to resolve at or after `T` ms).

**Validates: Requirements 4.2, 4.3, 4.4, 4.5**

### Property 9: A logging failure on the `loop_cap` append does not propagate

*For any* `logFn` that, when called with a `loop_cap` entry, throws synchronously, returns a rejected promise, or rejects after a delay, the awaited promise from `Agent.sendMessage` for the cap-triggering call still resolves (does not reject) to `Cap_Reply` for the configured `N`. Logging failures for non-`loop_cap` kinds are out of scope of this property; they retain whatever behaviour the existing `emit` already has.

**Validates: Requirements 4.6**

### Property 10: Event ordering on every post-first iteration

*For any* `Max_Iterations` value `N ≥ 1` and *for any* mock OpenAI sequence:
- the count of `retry` events emitted during the turn equals `iterations_performed - 1` (so `N - 1` when the cap fires, `K - 1` when a final reply is produced on iteration `K`),
- each `retry` event for iteration `i ≥ 2` appears immediately before that iteration's first non-`retry` event (`tool_call`, `model_reply`, or `loop_cap`),
- on the capping iteration, the trace tail is `..., retry, loop_cap` (when `N ≥ 2`) or just `loop_cap` (when `N === 1`), with **no** `tool_call`, `tool_result`, or `model_reply` event between the `retry` for the capping iteration and the `loop_cap` event.

**Validates: Requirements 6.3, 6.4**

## Error Handling

The cap path is the *non-error* path for runaway loops: `Agent.sendMessage` resolves to `Cap_Reply` rather than rejecting. The remaining error concerns are narrow.

### Invalid `AGENT_MAX_ITERATIONS` at startup

`resolveMaxIterations()` writes one `console.warn(...)` line to stderr describing the rejected value, then returns `25`. The agent continues to start and operate. No exception is thrown, and the env var is not re-read — a typo in `.env` produces one warning at boot, not a flood.

The exact format of the warning (constants for prefix, var name, value rendering) is asserted by Property 2; the message text itself is not part of the spec, only the inclusion of the literal `AGENT_MAX_ITERATIONS` and the rejected raw string.

### `chat.completions.create` errors

Out of scope. The cap does not change anything about how API errors propagate; if `chat.completions.create` rejects, that rejection still bubbles up through `runLoop` to `sendMessage` and is caught by the existing `catch (error: any)` in `index.ts` that produces `❌ Error from agent: ...`. The cap branch never runs in this case because we never reach the `tool_calls` check.

### Tool execution errors

Out of scope. Tool errors are handled inside `toolRunner` today (returning a string) and that path is unchanged. The cap branch fires before any tools run on the capping iteration, so a misbehaving tool cannot prevent the cap from firing.

### `logFn` failure on the `loop_cap` event

Property 9 governs this case. The cap branch wraps `await this.emit({ kind: "loop_cap", ... })` in `try { ... } catch { /* swallow */ }` so any synchronous throw or rejected promise is swallowed. `Cap_Reply` is then returned through the normal resolve path. The existing `emit` for non-`loop_cap` kinds is **not** changed; we do not retroactively make every emit infallible. This minimises the diff and avoids hiding bugs in unrelated code paths.

### `MessageBatcher.enqueue` failure (Telegram delivery)

Out of scope of `Agent`. `index.ts`'s existing `try { ... } catch (error: any) { ...batcher.enqueue(chatId, ❌ Error from agent: ${error.message}) }` already covers this: if `batcher.enqueue` of the cap reply throws, the existing handler logs and tries to enqueue an error message. Whether *that* second enqueue also throws is a pre-existing concern; this feature does not introduce or fix it. Requirement 3.4 is satisfied because the catch is already present and the cap path uses the identical wiring as a normal reply (Requirement 3.3).

### Misc.

- An `Agent` instance with `Max_Iterations === 1` and a mock that wants tools on iteration 1 still emits `loop_cap` on the first iteration; no `retry` is emitted because `attempt === 1`. This matches Property 10's `N === 1` clause and Requirement 6.3 ("any iteration after the first" excludes the first).
- An `Agent` instance with `Max_Iterations === 1` whose mock returns a final reply on the first iteration produces the model reply normally, with zero `retry` events and zero `loop_cap` events. Requirement 6.1 holds trivially.

## Testing Strategy

### Approach

We use the dual approach the workflow recommends:

- **Property-based tests** (10 properties above) drive the cap branch, the resolver, and the event-ordering invariants over many generated inputs. Pure function tests (P1, P2, P5) and mock-driven loop tests (P3, P4, P6, P7, P8, P9, P10) keep iteration cost low — no real DeepSeek calls, no network.
- **Example-based unit tests** cover the `index.ts` Telegram wiring (cap reply enqueued via batcher, error path on enqueue failure) where behaviour does not vary meaningfully with input (Requirements 3.3, 3.4, 5.1).
- **A single smoke test** confirms `appendHistory({ kind: "loop_cap", ... })` writes a parseable JSONL line (Requirement 4.1). The TypeScript union extension is itself enforced by the type-checker.

### Tooling

- **Library**: [`fast-check`](https://github.com/dubzzz/fast-check) for property-based testing in TypeScript/Bun. It integrates with Bun's test runner and supports async properties (we need this for `await sendMessage`). It is the de-facto standard for PBT in the JS/TS ecosystem and is well-suited to our small input domains (integers in `[1, 1000]`, strings drawn from limited alphabets, arrays of mock chat completions).
- **Runner**: `bun test`. No new runner.
- **Mocks**:
  - `MockOpenAI`: a hand-rolled object exposing `chat.completions.create` whose return value is driven by a script (an array of pre-canned responses, plus a generator hook for unbounded loops). Constructed once per property iteration. No network.
  - `mockLogFn`: a `(entry) => Promise<void>` that records every entry into an in-memory array, optionally introducing delays or rejections per Property 9.
  - `mockOnMessageCallback`: a no-op or recorder; we do not need to assert on it for cap-related properties (no notification is required for `Cap_Reply` itself; only `loop_cap` event emission and the `sendMessage` return value matter).
- **No real network calls** are made from any property test.

### Configuration

Each property test runs **at minimum 100 iterations** (`fc.assert(prop, { numRuns: 100 })`). For the cheaper pure-function properties (P1, P2, P5) we raise this to `numRuns: 1000` to stress the resolver across the full integer range. The model-based property (P4) caps at `numRuns: 100` because each iteration drives a full mock loop; this is still cheap (no I/O).

Each property test is tagged at the top with a comment of the form:

```ts
// Feature: cap-agent-tool-loop, Property 6: When the cap fires, the loop halts at
// iteration N and sendMessage resolves to Cap_Reply.
```

This matches the workflow's required tag format.

### Test layout

```
deepseek-agent/
  agent.test.ts        # Properties 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 + smoke check for 4.1
  index.test.ts        # Example tests for 3.3, 3.4, 5.1 (Telegram wiring)
```

Each property is implemented as a **single** `fc.assert(...)` call, per the workflow's "one PBT test per property" rule. Edge cases identified in the prework (e.g. `N === 1`, `N === 1000`, whitespace-only env values, integers `0`, `1001`, negative integers) are folded into the generators rather than written as separate tests; that is what PBT is for.

### Mapping properties to tests

| Property | Test name (suggested) | Generator highlights |
|---|---|---|
| P1 — resolver purity | `resolveMaxIterations is pure over env input` | `fc.oneof(fc.constant(undefined), arbitraryWhitespaceStr, validIntStr, invalidIntStr, ...)` |
| P2 — warn on invalid | `invalid AGENT_MAX_ITERATIONS warns exactly once` | invalid string generator + `console.warn` spy |
| P3 — cap stable, counter scoped | `cap value is fixed; counter resets per call` | sequences of mutations + sequences of mock turns |
| P4 — below-cap fidelity | `below-cap behaviour matches reference impl` | `(N, K, mock-completion-sequence)` with `K ≤ N` |
| P5 — Cap_Reply formatting | `Cap_Reply round-trips through regex` | `fc.integer({ min: 1, max: 1000 })` |
| P6 — cap halts and resolves | `cap fires at exactly N iterations` | `(N, source, mock-tool-calls-shape)` |
| P7 — history preserves capping msg | `capping assistant msg is the last history entry` | random assistant msg with random tool_calls |
| P8 — loop_cap entry faithful | `loop_cap entry records (source, text, max_iterations, model)` | `(N, source, model)` + delayed logFn |
| P9 — log failure non-fatal | `logFn failure on loop_cap does not propagate` | logFn variants (sync throw, rejected promise, delayed reject) |
| P10 — event ordering | `retry precedes every post-first iteration; cap tail is retry+loop_cap` | `(N, mock-sequence)` |

### Pre-feature reference for Property 4

Property 4 ("below-cap behaviour matches the pre-feature implementation") needs a reference. We extract the existing `runLoop` body into a helper exported from a small fixture file, e.g. `agent.legacy.ts`, that mirrors the current loop without the cap branch. Both implementations share the same OpenAI mock and the same `logFn` mock; the property asserts deep-equality of the recorded event trace and final history. This makes regressions in below-cap behaviour fail loudly without needing to reason about the diff manually.

This fixture is test-only (not shipped) and is removed once the feature stabilises if the maintenance cost outweighs its value. While the feature is new, it is the strongest possible guarantee that the cap is invisible below the threshold.

### What we are *not* testing as properties

Per the prework's classification:

- **Telegram message delivery via `MessageBatcher.enqueue`** (Requirements 3.3, 3.4, 5.1): example-based unit tests in `index.test.ts`. Behaviour does not vary with input — it is a wiring check.
- **`EventKind` includes `"loop_cap"`** (Requirement 4.1): the TypeScript type system handles this; one runtime smoke test asserts that `appendHistory({ kind: "loop_cap", ... })` writes a JSONL line that parses back correctly.
- **Hypothetical cap-logic-itself-fails clause** (Requirement 5.3): no realistic failure mode given a plain numeric counter and a `>=` comparison. Subsumed by Property 6's "no rejection" clause.
- **Transient pre-resolution interval** (Requirement 2.6): module-load resolution makes this interval effectively zero. Code-level inspection is sufficient.

### Manual verification

Beyond the automated tests, two manual checks are warranted before merge:

1. **Hand-run with `AGENT_MAX_ITERATIONS=2`**: ask the agent something that requires multiple tool calls; observe the cap firing in the JSONL log and the user-facing `⚠️ Agent gave up after 2 iterations.` reply in Telegram.
2. **Hand-run with `AGENT_MAX_ITERATIONS=garbage`**: confirm the warning appears once on stderr at boot and that the agent runs with the default 25.

### Files changed (recap)

- `deepseek-agent/agent.ts` — add `resolveMaxIterations`, `RESOLVED_MAX_ITERATIONS`, `Agent#maxIterations`, and the cap branch in `runLoop`.
- `log/logger.ts` — extend `EventKind` union with `"loop_cap"`.
- `deepseek-agent/.env.example` — add the optional `AGENT_MAX_ITERATIONS` documentation line.
- New test files: `deepseek-agent/agent.test.ts`, `deepseek-agent/index.test.ts`, and (optionally) `deepseek-agent/agent.legacy.ts` as a pre-feature reference fixture.

No changes are required in `deepseek-agent/index.ts`, `deepseek-agent/batcher.ts`, `deepseek-agent/tools.ts`, or `vox/index.ts`.
