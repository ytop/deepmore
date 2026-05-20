# deepmore — Design Document

## Overview

`deepmore` is a self-optimising AI agent that runs locally on the user's machine, exposed primarily through a Telegram bot and secondarily through a TUI shell. It uses DeepSeek's chat completion API to power an agent loop that has direct access to the host: it can run shell commands, read and write files, search the workspace, and inspect Vue UI components. A companion process (`vox`) supervises the agent, keeps a structured interaction log, and once a day reads that log to ask DeepSeek for a self-improvement to the agent's own source code — applying it, verifying it builds, committing, pushing, and rolling back on failure.

The system is built on Bun + TypeScript and is deliberately compact: two packages, a shared logger, and a small number of dependencies (`grammy`, `openai`, `dotenv`).

## Repository Layout

```
deepmore/
├── deepseek-telegram-agent/   # Telegram bot + AI agent core
│   ├── index.ts               # Bot bootstrap, auth, command routing
│   ├── agent.ts               # Agent class (chat loop + tool calling)
│   ├── tools.ts               # Tool definitions + safe executors
│   ├── batcher.ts             # Outbound message batching for Telegram
│   └── .env.example           # Required environment variables
├── log/
│   └── logger.ts              # Shared JSONL history (interaction log)
└── vox/
    └── index.ts               # TUI wrapper + 04:00 self-optimisation cron
```

## Architecture

### High-level component diagram

```
┌────────────────┐        ┌──────────────────────────────────────────────┐
│   Telegram     │◀──────▶│            deepseek-telegram-agent           │
│   user chat    │        │  ┌─────────────┐  ┌──────────┐  ┌─────────┐  │
└────────────────┘        │  │  index.ts   │  │ agent.ts │  │tools.ts │  │
                          │  │ (grammy bot │─▶│ (loop +  │─▶│ shell / │  │
                          │  │  + auth)    │  │  tools)  │  │ files)  │  │
                          │  └─────────────┘  └──────────┘  └─────────┘  │
                          │         │              │              │      │
                          │         ▼              ▼              ▼      │
                          │  ┌─────────────────────────────────────────┐ │
                          │  │           log/logger.ts (JSONL)         │ │
                          │  └─────────────────────────────────────────┘ │
                          └──────────────────────┬───────────────────────┘
                                                 │ spawn / supervise
                          ┌──────────────────────┴───────────────────────┐
                          │                     vox                      │
                          │  ┌──────────┐   ┌────────────────────────┐   │
                          │  │   TUI    │   │  04:00 self-optimiser  │   │
                          │  │ readline │   │  read 24h history →    │   │
                          │  │ commands │   │  ask DeepSeek →        │   │
                          │  └──────────┘   │  write file → build →  │   │
                          │                 │  commit → push →       │   │
                          │                 │  restart agent         │   │
                          │                 └────────────────────────┘   │
                          └──────────────────────────────────────────────┘
                                                 │
                                                 ▼
                                       ┌───────────────────┐
                                       │  DeepSeek API     │
                                       │  (chat + tools)   │
                                       └───────────────────┘
```

### Process model

There are two long-running Bun processes:

1. **`deepseek-telegram-agent`** — a single process that hosts the Telegram bot and the in-memory agent. It can run standalone.
2. **`vox`** — a parent process that spawns the agent as a subprocess (`stdio: inherit`), accepts TUI input via `readline`, and runs the self-optimisation cron. When optimisation rewrites agent source, vox restarts the subprocess.

Both processes share a single append-only JSONL log file (`log/history.jsonl`) which is the source of truth for "what happened in the last 24 hours" used by the optimiser.

## Component Design

### 1. Telegram bot (`deepseek-telegram-agent/index.ts`)

Bootstraps the system and wires three things together: a `grammy` `Bot`, a `MessageBatcher`, and an `Agent`.

Responsibilities:
- Loads `.env` and validates required variables (`TELEGRAM_BOT_TOKEN`, `DEEPSEEK_API_KEY`, `ALLOWED_USER_ID`); exits non-zero if any are missing.
- Authorisation middleware: every update is rejected unless `ctx.from.id === ALLOWED_USER_ID`. Setting `ALLOWED_USER_ID=0` disables the check (allow-all).
- Command handlers:
  - `/start`, `/help` — welcome message.
  - `/new`, `/reset` — calls `agent.resetMemory()`.
  - any other text — forwarded to `agent.sendMessage(...)`.
- Wires the agent's `onMessage` callback so the agent can push proactive notifications (tool start/finish) into the batcher.
- Wires the agent's `logFn` to `appendHistory(...)` so every event lands in the shared log.
- Handles `SIGINT`/`SIGTERM` by flushing pending batched messages before stopping the bot.

### 2. Agent core (`deepseek-telegram-agent/agent.ts`)

Encapsulates the chat-with-tools loop against DeepSeek's OpenAI-compatible API.

Key design choices:
- **Stateful conversation memory** held in `this.history` as an OpenAI `ChatCompletionMessageParam[]`. The first entry is a system prompt that tells the model it is in YOLO mode and (if set) names the workspace directory.
- **`resetMemory()`** preserves only the system prompt, dropping all subsequent turns.
- **Run loop (`runLoop`)** — an unbounded `while (true)` that:
  1. Calls `chat.completions.create` with `tools` and `tool_choice: "auto"`.
  2. If the assistant message contains `tool_calls`, it iterates each call, runs the tool via `toolRunner`, appends a `role: "tool"` message with the result, emits structured log entries (`tool_call`, `tool_result`), and pushes user-visible notifications (`🛠 Running tool: …` / `✅ Tool finished: …`).
  3. If there are no tool calls, the assistant text is logged as `model_reply` and returned to the caller.
  - The `attempt` counter logs a `retry` event each iteration after the first; there is no hard cap, so the loop runs as long as the model keeps requesting tools.
- **Source/chatId propagation** — `sendMessage(message, source, chatId)` lets vox prompts and Telegram prompts share the same agent instance while logs and notifications stay correctly tagged.

### 3. Tools (`deepseek-telegram-agent/tools.ts`)

Five tools are exposed to the model, all defined as OpenAI function tools and dispatched by the `toolRunner` map.

| Tool | Purpose | Notable safeguards |
|---|---|---|
| `run_shell_command` | Run an arbitrary shell command via `child_process.exec`. | Blocked-pattern allowlist (`rm -rf /`, `mkfs`, `dd`, fork bomb, raw device writes, `chmod 777`, `wget|bash`, `curl|bash`); 30 s timeout; 10 MB output cap. |
| `search_files` | Combined `find` + `grep` search. Takes `name_pattern`, optional `content_pattern`, optional `directory`, optional `max_results` (default 50). | Defaults to `WORKSPACE` env var; escapes regex metacharacters in the content pattern; 30 s timeout; uses `head -N` to cap output. |
| `read_file` | Read a UTF-8 file. | If `WORKSPACE` is set, rejects paths that resolve outside it (directory-traversal guard). |
| `write_file` | Overwrite a UTF-8 file. | Same workspace boundary check as `read_file`. |
| `inspect_ui_component` | Parses `<style>` blocks from a Vue file and surfaces CSS rules for a given selector, calling out interaction-affecting properties (`overflow`, `position`, `z-index`, `display`, `visibility`, `pointer-events`, `opacity`). | Read-only; uses naive line-based CSS parsing scoped to one file. |

The block-list in `validateCommand` is a lightweight safety net, not a sandbox. The agent runs with the user's full shell privileges by design ("YOLO mode").

### 4. Outbound message batcher (`deepseek-telegram-agent/batcher.ts`)

An agent turn often produces many short notifications (tool started, tool finished, final reply). Sending each one as a separate Telegram message would be noisy and rate-limited. `MessageBatcher` buffers them per-chat and flushes after a 10 s quiet window.

Behaviour:
- `enqueue(chatId, message)` pushes onto a per-chat queue, (re)starts a 10 s flush timer if not already running, and ensures a typing indicator is being sent every 5 s.
- `flush(chatId)` clears the timer and typing interval, joins queued messages with `\n==========\n`, and sends them in chunks of 4 000 characters using `Array.from` to slice on grapheme/code-point boundaries (emoji-safe).
- `flushAll()` is awaited from `SIGINT`/`SIGTERM` handlers so nothing is lost on shutdown.

Note: each call to `enqueue` resets the typing indicator interval, but the 10 s flush timer is only set once per batch — meaning a stream of fast notifications still flushes at most every 10 s after the first message in the batch.

### 5. Shared logger (`log/logger.ts`)

A thin append-only JSONL writer/reader.

```ts
type EventKind =
  | "telegram_in" | "telegram_out"
  | "vox_in"
  | "model_reply"
  | "tool_call" | "tool_result"
  | "retry";

interface HistoryEntry {
  ts: number;
  kind: EventKind;
  source: "telegram" | "vox";
  text: string;
  meta?: Record<string, unknown>;
}
```

- `appendHistory(entry)` — `fs.appendFile` to `log/history.jsonl`.
- `readRecentHistory(windowMs = 24h)` — reads the file, parses each line, returns entries with `ts >= now - windowMs`. Returns `[]` if the file does not exist yet.

This is the contract between the agent (writer) and vox's optimiser (reader).

### 6. vox TUI + self-optimiser (`vox/index.ts`)

vox has three concerns: supervising the agent subprocess, providing a TUI, and running the daily optimiser.

**Sub-process supervision**
- `startAgent()` spawns `bun run index.ts` in `deepseek-telegram-agent/` with `stdio: "inherit"` so the agent's logs go straight to vox's terminal.
- `stopAgent()` kills the subprocess and awaits exit.
- `restartAgent()` is `stop` then `start`, used both manually (`/restart`) and after a successful self-optimisation.

**TUI loop**
- Built on Node `readline`. Three slash commands (`/quit`, `/restart`, `/optimise`) plus a default branch that records any other input as a `vox_in` history entry. Real prompts are still expected to be sent via Telegram; the TUI is for control + history seeding.

**Scheduler**
- `msUntil4am()` computes the delay to the next 04:00 local. `schedule4am()` runs the optimiser after that delay and then re-schedules itself, giving a daily cadence without external cron.

**Self-optimisation pipeline (`runOptimisation`)**

1. Read the last 24 h of `HistoryEntry`s. If empty, skip.
2. Read the three agent source files (`agent.ts`, `tools.ts`, `index.ts`).
3. Send to DeepSeek (`deepseek-chat`) with a system prompt that asks for a JSON object:
   ```json
   {
     "critical": true|false,
     "title": "…",
     "description": "…",
     "file": "agent.ts" | "tools.ts" | "index.ts",
     "new_content": "<full replacement file>"
   }
   ```
4. Parse JSON tolerantly: try a fenced code block first (` ```json … ``` `), fall back to the first `{ … }` match. On parse failure, log and bail.
5. If `critical === false` (or required fields missing), log "no critical improvement" and bail.
6. Otherwise:
   - Capture `prevCommit = git rev-parse HEAD`.
   - Overwrite the target file with `new_content`.
   - Run `bun build --target=bun index.ts` in the agent directory.
   - **Build fails** → `git reset --hard <prevCommit>` and stop.
   - **Build succeeds** → `git add <file>` → `git commit -m "vox: <title>"` → `git push` → `restartAgent()`.

**Logs** are written to `vox/vox.log` (timestamped) and also echoed to stdout.

## Data Flow Examples

### A Telegram prompt that triggers a tool

```
User → Telegram → grammy "message:text" handler
              → ctx.replyWithChatAction("typing")
              → agent.sendMessage(text, "telegram", chatId)
                  → log: telegram_in
                  → loop iter 1: model returns tool_calls=[run_shell_command]
                      → log: tool_call, notify "🛠 Running tool…"
                      → toolRunner.run_shell_command(...)
                      → log: tool_result, notify "✅ Tool finished…"
                  → loop iter 2: model returns final text
                      → log: model_reply, return reply
              → log: telegram_out
              → batcher.enqueue(chatId, reply)
              → (≤10s later) batcher.flush → bot.api.sendMessage in 4 000-char chunks
```

### Daily self-optimisation

```
04:00 local → readRecentHistory(24h) → openai.chat.completions.create
            → parse JSON suggestion
            → critical?
                 ├─ no  → log + return
                 └─ yes → fs.writeFile(target)
                       → bun build
                            ├─ fail → git reset --hard prevCommit
                            └─ ok   → git add/commit/push → restartAgent
```

## Configuration

All configuration is via `.env` in `deepseek-telegram-agent/`. vox reads the same file via a path-relative `dotenv` call.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | grammy bot token. |
| `DEEPSEEK_API_KEY` | yes | — | DeepSeek API key (used by both agent and vox). |
| `ALLOWED_USER_ID` | yes | — | Telegram user ID allowed to chat; `0` = allow all. |
| `DEEPSEEK_BASE_URL` | no | `https://api.deepseek.com` | Override API base. |
| `DEEPSEEK_MODEL_BASE` | no | `deepseek-chat` | Model used by the agent loop. |
| `DEEPSEEK_MODEL_ULTRA` | no | `deepseek-reasoner` | Defined in env example; not currently referenced in code. |
| `WORKSPACE` | no | unset | If set, restricts `read_file`/`write_file` to that directory and is the default search root for `search_files`. |

## Security Posture

This system is explicitly designed to give an LLM full control of a user's machine. The README calls this "YOLO mode". The trust boundaries are:

- **Authentication**: a single Telegram user ID. Anyone else who messages the bot is rejected with an unauthorised reply. Setting `ALLOWED_USER_ID=0` disables this.
- **Shell allow-list**: a small regex blocklist for obviously catastrophic commands. This is not a sandbox; bypasses are easy. The 30 s timeout and 10 MB output cap limit individual command blast radius.
- **Filesystem boundary**: `read_file`/`write_file` enforce `WORKSPACE` if set, but `run_shell_command` does not — a shell command can read or write anywhere the user can. `WORKSPACE` is therefore a soft hint, not a hard sandbox.
- **Self-modifying code**: vox commits and pushes changes generated by an LLM. The build check (`bun build`) only verifies the file parses and bundles, not that it behaves correctly. Rollback is a `git reset --hard` to the previous commit, which discards any other in-flight changes.

The intended deployment is a personal machine controlled by the same person who is on the other end of the Telegram chat.

## Notable Design Decisions

- **Telegram as primary surface, TUI as supervisor**. The TUI is intentionally not a chat interface — its commands are about controlling the agent (`/restart`, `/optimise`) rather than talking to it. Free-form input is logged so it can influence the next optimisation cycle.
- **JSONL history as the only persistence**. There is no database; the optimiser reads the last 24 h every morning and otherwise the system is stateless across restarts (in-memory conversation only).
- **Whole-file replacement, not patches**. The optimiser asks for `new_content` as the full file. This is simpler and more robust to LLM formatting variability than diff parsing, at the cost of larger model outputs.
- **Build-as-acceptance-test**. The only gate before commit-and-push is `bun build`. There are no unit tests in the repo, so the safety net for self-modifications is "it compiles" plus `git reset --hard` on failure.
- **Outbound batching, not inbound**. Inbound Telegram messages are processed one at a time; outbound notifications are batched per chat to keep the conversation readable.
- **Single agent instance per process**. Conversation memory is global to the agent, not per-chat. This is fine because authorisation pins the bot to a single user.

## Known Limitations & Risks

- The agent loop has no maximum iteration count — a model that repeatedly emits tool calls can spin until the API errors.
- Notifications truncate tool output to 100 characters in the user-facing message; the full output still goes to the model and the log.
- `inspect_ui_component` uses line-based CSS parsing; it will misbehave on minified CSS or rules spanning multiple lines without typical formatting.
- vox restarts the agent on successful optimisation but the running Telegram chat session loses its in-memory history.
- No retry/backoff on DeepSeek API errors.
- `DEEPSEEK_MODEL_ULTRA` is documented but unused.
- The blocklist for `run_shell_command` is shallow; it is not a security boundary.
