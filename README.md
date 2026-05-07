# deepmore

A self-optimising DeepSeek AI agent accessible via Telegram, with a local TUI shell.

## Architecture

```
deepmore/
├── deepseek-telegram-agent/   # Telegram bot + AI agent core
│   ├── index.ts               # Bot entrypoint
│   ├── agent.ts               # Agent class (chat loop + tool calling)
│   └── tools.ts               # Tool definitions (shell, read/write file)
└── vox/                       # TUI wrapper + self-optimisation scheduler
    └── index.ts               # Starts the agent, runs 04:00 cron
```

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- A [Telegram bot token](https://t.me/BotFather)
- A [DeepSeek API key](https://platform.deepseek.com)

## Install

```bash
# Install dependencies for both packages
cd deepseek-telegram-agent && bun install && cd ..
cd vox && bun install && cd ..
```

## Configuration

Copy and fill in the env file:

```bash
cp deepseek-telegram-agent/.env.example deepseek-telegram-agent/.env
```

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token from @BotFather |
| `DEEPSEEK_API_KEY` | ✅ | DeepSeek platform API key |
| `ALLOWED_USER_ID` | ✅ | Your Telegram user ID (set `0` to allow all) |
| `DEEPSEEK_BASE_URL` | optional | Override API base URL |
| `DEEPSEEK_MODEL_BASE` | optional | Chat model (default: `deepseek-chat`) |
| `DEEPSEEK_MODEL_ULTRA` | optional | Reasoning model (default: `deepseek-reasoner`) |
| `WORKSPACE` | optional | Directory the agent is allowed to read/write |

## Quickstart

### Run the Telegram bot directly

```bash
cd deepseek-telegram-agent
bun run index.ts
```

### Run via vox (recommended)

`vox` starts the bot as a subprocess and adds the TUI shell + daily self-optimisation.

```bash
cd vox
bun run index.ts
```

Or install globally and run from anywhere:

```bash
cd vox && bun link
vox
```

## Main Functions

### Telegram bot (`deepseek-telegram-agent`)

| Command | Description |
|---|---|
| `/start` / `/help` | Show welcome message |
| `/new` / `/reset` | Clear conversation memory |
| _(any message)_ | Send a prompt to the agent |

The agent runs in **YOLO mode** — tools execute immediately without confirmation. It can:
- Run arbitrary shell commands on the host machine
- Read and write files
- Send proactive Telegram notifications as it works

### vox TUI shell

| Command | Description |
|---|---|
| `/quit` / `/exit` | Stop agent and exit |
| `/restart` | Restart the sub-agent process |
| `/optimise` | Trigger the self-optimisation cycle immediately |
| _(any text)_ | Logged to `history.jsonl` for optimisation analysis |

### Self-optimisation (daily at 04:00 local time)

Every day vox automatically:

1. Reads the last 24 h of interaction history from `vox/history.jsonl`
2. Sends the history + agent source to DeepSeek and asks for the single most impactful improvement
3. If a critical improvement is found, writes the updated file and verifies it compiles (`bun build`)
4. On success: commits the change and `git push`es, then restarts the agent
5. On failure: `git reset --hard` to the previous commit — no broken state left behind

Logs are written to `vox/vox.log`.
