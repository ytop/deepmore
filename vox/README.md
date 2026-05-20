# vox

TUI wrapper for `deepseek-agent`.

## Usage

```bash
cd vox
bun install
bun run index.ts
```

Or install globally:

```bash
bun link          # from vox/
vox               # from anywhere
```

## TUI commands

| Command | Action |
|---------|--------|
| `/quit` / `/exit` | Stop agent and exit |
| `/restart` | Restart the sub-agent |
| `/optimise` | Trigger optimisation cycle immediately |
| any other text | Logged to history (send actual prompts via Telegram) |

## Self-optimisation

Every day at **04:00 local time** vox:

1. Reads the last 24h of interaction history from `history.jsonl`
2. Asks DeepSeek to identify the single most critical improvement to the agent code
3. If one is found, writes the updated file, verifies it compiles (`bun build`)
4. On success: commits + `git push`, then restarts the agent
5. On failure: `git reset --hard` to the previous commit

## Environment

Reads `.env` from `../deepseek-agent/.env`. No separate config needed.
