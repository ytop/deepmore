# Requirements Document

## Introduction

The `deepseek-telegram-agent` runs an unbounded `while (true)` tool-calling loop in `Agent.runLoop` (`deepseek-telegram-agent/agent.ts`). A model that keeps emitting tool calls will spin until the DeepSeek API errors out, burning credits and host resources with no clear signal to the user. This feature adds a hard cap on the number of iterations the agent loop performs in a single turn and surfaces a clear, user-visible reply when the cap is reached. The cap MUST apply uniformly to all callers of `Agent.sendMessage`, including Telegram chat input and `vox` TUI input, and MUST be observable in the structured history log so the daily self-optimiser can reason about it.

## Glossary

- **Agent**: The `Agent` class exported by `deepseek-telegram-agent/agent.ts`.
- **Run_Loop**: The private method `Agent.runLoop` that drives one user turn through repeated `chat.completions.create` calls and tool dispatch.
- **Iteration**: One pass through the body of `Run_Loop`, consisting of exactly one `chat.completions.create` call and the processing of any returned `tool_calls`. The first pass is iteration 1.
- **Max_Iterations**: The configured upper bound on iterations per call to `Agent.sendMessage`. Defaults to 25.
- **Cap_Reached**: The condition where `Run_Loop` has executed `Max_Iterations` iterations and the model is still requesting tool calls (i.e., the next iteration would exceed the cap).
- **Cap_Reply**: The text reply returned by `Agent.sendMessage` when `Cap_Reached` occurs. Format: `⚠️ Agent gave up after N iterations.` where N is the value of `Max_Iterations` actually used for the turn.
- **History_Log**: The append-only JSONL file written via `appendHistory` in `log/logger.ts`.
- **EventKind**: The `EventKind` union in `log/logger.ts`.
- **Loop_Cap_Event_Kind**: A new `EventKind` value, `"loop_cap"`, added to `log/logger.ts` to mark cap termination distinctly from generic `retry` events and from model errors.
- **Cap_Env_Var**: The environment variable `AGENT_MAX_ITERATIONS`, optionally set in `.env`, used to override `Max_Iterations`.
- **Message_Batcher**: The `MessageBatcher` instance in `deepseek-telegram-agent/index.ts` used to deliver agent replies and notifications to Telegram.

## Requirements

### Requirement 1: Bounded Loop Iterations

**User Story:** As the operator of the agent, I want the tool-calling loop to terminate after a bounded number of iterations, so that a model stuck in a tool-calling spiral cannot burn credits or host resources indefinitely.

#### Acceptance Criteria

1. WHEN `Run_Loop` is invoked, THE Agent SHALL set the iteration counter for that call to zero before executing the first iteration.
2. WHEN `Run_Loop` completes one iteration of the request-response cycle, THE Agent SHALL increment the iteration counter for that call by exactly one.
3. THE Agent SHALL treat `Max_Iterations` as a configurable positive integer with a default value of 25 and a permitted range of 1 to 1000 inclusive.
4. IF the iteration counter for the current call to `Run_Loop` has reached `Max_Iterations` and the most recent assistant message contains one or more `tool_calls`, THEN THE Agent SHALL halt the loop without executing any of those pending `tool_calls` and SHALL return control to the caller with an indication that the iteration cap was reached.
5. WHEN `Run_Loop` produces an assistant message containing zero `tool_calls` while the iteration counter is less than or equal to `Max_Iterations`, THE Agent SHALL return that assistant message's content to the caller without truncation, modification, or additional iterations.
6. THE Agent SHALL ensure that the iteration counter is scoped to a single call of `Run_Loop` and is not shared, accumulated, or persisted across separate calls to `Run_Loop`.

### Requirement 2: Default and Configurable Cap Value

**User Story:** As the operator of the agent, I want a sensible default cap with the option to override it via configuration, so that I can tune the safety net without editing source code.

#### Acceptance Criteria

1. IF `Cap_Env_Var` is unset in the process environment, or is set to a string that is empty or contains only whitespace characters, THEN THE Agent SHALL use the hardcoded default `Max_Iterations` value of 25 for all calls to `Run_Loop`.
2. WHERE `Cap_Env_Var` is set to a non-empty string whose characters, after trimming leading and trailing whitespace, consist solely of ASCII digits 0-9 and represent an integer in the inclusive range 1 to 1000, THE Agent SHALL use that integer as `Max_Iterations` for all calls to `Run_Loop` that begin after process start.
3. IF `Cap_Env_Var` is set to a non-empty, non-whitespace-only string that does not satisfy the parsing rule in criterion 2 (including but not limited to: containing non-digit characters after trimming, representing the integer 0, representing a negative integer, or representing an integer greater than 1000), THEN THE Agent SHALL use the hardcoded default `Max_Iterations` value of 25 for all calls to `Run_Loop`, regardless of any previously evaluated value.
4. IF `Cap_Env_Var` is set to a non-empty, non-whitespace-only string that does not satisfy the parsing rule in criterion 2, THEN THE Agent SHALL emit one warning entry to standard error that includes both the literal name `AGENT_MAX_ITERATIONS` and the rejected raw string value, before the first call to `Run_Loop` begins.
5. THE Agent SHALL evaluate `Cap_Env_Var` exactly once, before the first call to `Run_Loop` begins, and SHALL NOT re-read `Cap_Env_Var` during the lifetime of an `Agent` instance.
6. WHILE the one-time evaluation of `Cap_Env_Var` has not yet produced a value, THE Agent SHALL use the hardcoded default `Max_Iterations` value of 25 for any call to `Run_Loop` that begins during that interval.
7. WHEN the one-time evaluation of `Cap_Env_Var` completes, THE Agent SHALL use the evaluated `Max_Iterations` value for every subsequent call to `Run_Loop` whose entry into `Run_Loop` occurs strictly after evaluation completion, without altering the `Max_Iterations` value already in use by any `Run_Loop` call that is currently in progress.

### Requirement 3: User-Facing Cap Reply

**User Story:** As a user chatting with the agent over Telegram, I want a clear message when the agent gives up due to the iteration cap, so that I understand why no further work happened and I can adjust my prompt.

#### Acceptance Criteria

1. WHEN `Cap_Reached` occurs, THE Agent SHALL cause `Agent.sendMessage` to return the `Cap_Reply` string as its single return value in place of any model-generated final reply for that turn, and SHALL NOT additionally return or emit a model-generated final reply for the same turn.
2. THE `Cap_Reply` SHALL exactly equal the string `⚠️ Agent gave up after N iterations.` where N is the base-10 decimal representation of the integer value of `Max_Iterations` used for the turn, with no thousands separators and no surrounding whitespace, and SHALL contain the literal substring `Agent gave up after` followed by a single space, followed by N, followed by a single space, followed by the literal substring `iterations.`.
3. WHEN `Cap_Reached` occurs for a turn whose `source` is `"telegram"`, THE `index.ts` Telegram message handler SHALL deliver `Cap_Reply` to the user by invoking `Message_Batcher.enqueue` exactly once, targeting the same Telegram chat identifier as the user message that initiated the turn, using the identical invocation path used for a normal final reply.
4. IF `Message_Batcher.enqueue` throws or is unavailable when delivering `Cap_Reply` to a Telegram chat, THEN THE `index.ts` Telegram message handler SHALL allow the thrown error to propagate to its existing `catch (error: any)` branch, SHALL NOT terminate the Node.js process, and SHALL remain able to accept and process the next incoming Telegram message for any chat.
5. WHEN `Cap_Reached` occurs, THE Agent SHALL return `Cap_Reply` from `Agent.sendMessage` via a normal (non-throwing) return path so that the existing `❌ Error from agent: ...` error path in `index.ts` is not triggered for cap termination, and SHALL NOT propagate any exception out of `Agent.sendMessage` for the cap condition.
6. WHEN `Cap_Reached` occurs, THE Agent SHALL append, before `Agent.sendMessage` returns, exactly one message to its conversation history with role `assistant` whose content is the verbatim assistant message returned by the model on the iteration that triggered the cap, including any tool-call requests it contained, so that the next call to `Agent.sendMessage` observes a history ending with that assistant message.

### Requirement 4: Structured Logging of Cap Termination

**User Story:** As the maintainer of the daily self-optimiser, I want cap terminations to be distinguishable in the History_Log, so that the optimiser and any future telemetry can detect and reason about runaway loops.

#### Acceptance Criteria

1. THE `EventKind` union in `log/logger.ts` SHALL include the value `"loop_cap"`.
2. WHEN `Cap_Reached` occurs, THE Agent SHALL append exactly one entry to `History_Log` with `kind` equal to `"loop_cap"`, and SHALL await completion of that append operation before returning `Cap_Reply` from `Agent.sendMessage`.
3. THE `loop_cap` history entry SHALL set `source` to the original `source` value passed into the originating `Agent.sendMessage` call (`"telegram"` or `"vox"`), even if any internal value is changed during processing of the turn.
4. THE `loop_cap` history entry SHALL set `text` to the `Cap_Reply` string returned to the caller.
5. THE `loop_cap` history entry SHALL set `meta.max_iterations` to the integer value of `Max_Iterations` used for the turn and SHALL set `meta.model` to the value of the `model` field passed to the most recent `chat.completions.create` call made within `Run_Loop` for the turn; if no `chat.completions.create` call was made for the turn, `meta.model` SHALL be set to the value that would have been passed had a call occurred.
6. IF the append operation for the `loop_cap` history entry fails or throws, THEN THE Agent SHALL still return `Cap_Reply` from `Agent.sendMessage` via a normal (non-throwing) return path and SHALL NOT propagate the logging failure as an exception to the caller.

### Requirement 5: Source-Agnostic Application of the Cap

**User Story:** As the operator running both the Telegram bot and the `vox` TUI, I want the cap to apply identically regardless of how a turn was initiated, so that a runaway loop is impossible from any input surface.

#### Acceptance Criteria

1. IF `Agent.sendMessage` is called with `source` equal to `"telegram"`, THEN THE Agent SHALL enforce all acceptance criteria of Requirements 1, 3, and 4 for that call, including the Telegram-specific delivery of `Cap_Reply` via `Message_Batcher.enqueue` defined in Requirement 3.
2. IF `Agent.sendMessage` is called with `source` equal to `"vox"`, THEN THE Agent SHALL enforce all acceptance criteria of Requirements 1 and 4 for that call, AND SHALL enforce every acceptance criterion of Requirement 3 except those that explicitly reference the `index.ts` Telegram message handler or `Message_Batcher` (specifically Requirement 3 acceptance criteria 3 and 4), so that `Agent.sendMessage` returns `Cap_Reply` to the `vox` caller as its resolved value.
3. IF, during a call to `Agent.sendMessage`, the cap-enforcement logic detects that it cannot read or increment the iteration counter, or cannot evaluate `Cap_Reached` against `Max_Iterations`, within a single iteration of `Run_Loop`, THEN THE Agent SHALL stop executing further iterations of `Run_Loop` for that call, SHALL return `Cap_Reply` (using the `Max_Iterations` value resolved per Requirement 2) as the resolved value of `Agent.sendMessage`, SHALL emit exactly one `History_Log` entry with `kind` equal to `"loop_cap"` per Requirement 4 with `source` set to the original `source` of the call, and SHALL NOT throw an exception out of `Agent.sendMessage`.
4. WHEN `Agent.sendMessage` is invoked within the lifetime of a single `Agent` instance, THE Agent SHALL use the same integer value of `Max_Iterations` for that call regardless of whether `source` is `"telegram"` or `"vox"`, where that value is the one resolved per Requirement 2.
5. IF `Agent.sendMessage` is called with a `source` value that is neither `"telegram"` nor `"vox"`, THEN THE Agent SHALL still apply Requirement 1 (bounded loop iterations) to that call and SHALL return `Cap_Reply` as the resolved value of `Agent.sendMessage` if `Cap_Reached` occurs, without throwing an exception out of `Agent.sendMessage`.

### Requirement 6: Preservation of Existing Loop Behaviour Below the Cap

**User Story:** As a user of the agent, I want all current functionality of the tool-calling loop to keep working unchanged when the loop completes within the cap, so that this safety net does not change the day-to-day behaviour of the agent.

#### Acceptance Criteria

1. WHILE the iteration counter for the current call to `Run_Loop` is strictly less than `Max_Iterations` and `Cap_Reached` has not occurred, THE Agent SHALL execute each iteration using the same `chat.completions.create` request parameters (model, messages, tools, and any other arguments), tool dispatch sequence, history append operations, and event emission set (`retry`, `tool_call`, `tool_result`, `model_reply`) as defined for the pre-feature implementation, with no additional, omitted, or reordered events relative to that baseline.
2. WHEN a call to `Run_Loop` returns without `Cap_Reached` having occurred, THE Agent SHALL NOT append any `loop_cap` history entry for that call, and the history produced by that call SHALL be byte-for-byte identical to the history produced by the pre-feature implementation given the same input messages and tool responses.
3. WHEN `Run_Loop` begins any iteration after the first iteration of the current call, including the iteration on which `Cap_Reached` is detected, THE Agent SHALL emit exactly one `retry` history entry for that iteration before performing any other action of that iteration.
4. IF `Cap_Reached` is detected during an iteration, THEN THE Agent SHALL emit the `retry` history entry for that iteration before emitting the `loop_cap` history entry required by Requirement 4, and SHALL NOT emit any `tool_call`, `tool_result`, or `model_reply` event for that iteration.
