# deepmore — TODO / Upgrade Suggestions

Recommendations distilled from reading the current codebase (`design.md`) and surveying how leading self-optimising agents in 2025–2026 are built (Sakana's Darwin Gödel Machine, Claude Code's binary-evals/learnings loop, Anthropic's harness-design notes, AgentGit/GitButler "agent-safe git", Letta, etc.).

Items are grouped by intent and tagged with priority (**P0** must-fix, **P1** should-fix, **P2** nice-to-have) and rough effort (**S** ≤ half day, **M** 1–3 days, **L** 1+ week).

---

## 1. Reliability & correctness fixes

These are concrete defects or weak points in the current code, independent of any new features.

- [ ] **P0 / S — Cap the agent's tool-calling loop.** `Agent.runLoop` in `agent.ts` is `while (true)` with no maximum. A model that keeps emitting tool calls will spin until the API errors. Add `MAX_ITERATIONS` (e.g. 25) and surface a clear "agent gave up after N iterations" reply.
- [ ] **P0 / S — Make `WORKSPACE` actually constrain shell commands.** `read_file`/`write_file` enforce the workspace boundary, but `run_shell_command` ignores it entirely. If the boundary matters, run shell commands with `cwd: WORKSPACE` and refuse paths/redirects that escape. If it doesn't matter, drop the check from the file tools so the policy is consistent.
- [ ] **P1 / S — Make `searchFiles` injection-safe.** The current `find … -name "${name_pattern}"` interpolates user/model input directly into a shell string. The grep escape is good; replicate that for `name_pattern` and `directory`, or switch to `child_process.execFile` with argv arrays so no shell is invoked.
- [ ] **P1 / S — Wire `DEEPSEEK_MODEL_ULTRA` or remove it.** Documented in `.env.example` and README but not referenced anywhere. Either use it for a "hard task" path (e.g. when iteration count > N, escalate to the reasoner) or delete to avoid drift.
- [ ] **P1 / S — Retry/backoff on DeepSeek API errors.** A single 5xx during a tool loop currently surfaces as `❌ Error from agent: …` and loses the in-progress turn. Add exponential backoff with a small budget (e.g. 3 attempts, 1s/2s/4s) around the `chat.completions.create` call.
- [ ] **P1 / S — Fix `MessageBatcher` flush cadence.** The 10s timer is set on first enqueue and never extended, so a stream of fast notifications still flushes ≤10s after the *first* message — not the *last*. Either reset the timer on every enqueue (debounce) or document the current behaviour explicitly.
- [ ] **P2 / S — Replace the line-based CSS parser in `inspect_ui_component`.** It silently misbehaves on minified CSS or rules formatted on a single line. Use `postcss` or an equivalent. (Or remove the tool — see §5.)
- [ ] **P2 / S — Persist conversation memory across restarts.** vox restarts the agent on every successful self-optimisation, which silently wipes the in-flight Telegram conversation. Either snapshot `Agent.history` to disk on shutdown and reload on boot, or warn the Telegram user before restart.
- [ ] **P2 / S — Truncation symmetry in tool notifications.** `notifyUser` truncates tool output to 100 chars with `...`. For long file reads or shell output that's basically useless. Send the full output as a separate batched message or use a code-block-aware truncator.

---

## 2. Self-optimisation pipeline upgrades

Where the current `vox/index.ts` pipeline lags the state of the art and what to do about it.

- [ ] **P0 / M — Add a real evaluation gate, not just `bun build`.** Today the only check before `git push` is "does the file compile". Borrowing from the Claude Code binary-evals approach: define a small `evals/` directory of pass/fail assertions (smoke tests for each tool, a couple of canned conversations replayed against a stub LLM) and require all to pass before commit. This is the single highest-value upgrade.
- [ ] **P1 / M — Run optimisation on a branch, not on `main`.** Currently vox writes to the working tree and `git push`es to whatever branch HEAD is on. Switch to: branch off `vox/auto/<date>`, write + verify there, open a PR (or fast-forward merge to main only when evals pass). Aligns with the "agent-safe git" pattern documented by GitButler/AgentGit.
- [ ] **P1 / M — Keep an archive of past agent versions, not just `HEAD~1`.** Inspired by DGM's archive-of-stepping-stones idea. Even a thin version of this — git tags `vox/v1`, `vox/v2`, … with the pre-mutation history snippet that prompted each change — lets the optimiser reason "we already tried this last week and it regressed". Without it, the system can oscillate.
- [ ] **P1 / M — Generate K candidates and pick the best, instead of single-shot.** Today the model is asked for one improvement per cycle (`critical: true|false`). Asking for 3 candidates and running each through the eval gate, picking the winner, is closer to DGM's open-ended search and still cheap if K is small.
- [ ] **P1 / S — Add an iteration cap and budget guardrails to `runOptimisation`.** No upper bound on prompt size or model spend per cycle. Cap history bytes, cap source bytes, cap retries. Log token usage per cycle.
- [ ] **P1 / S — Tighten the self-modification scope.** The current prompt allows rewriting `agent.ts | tools.ts | index.ts` — the entire production agent. Start narrower: allow rewriting `tools.ts` only, or only the system-prompt string in `agent.ts`. Widen as confidence in the eval gate grows.
- [ ] **P2 / M — Telemetry on optimisation outcomes.** Append a structured entry to `history.jsonl` per cycle: `{kind: "vox_optimise", outcome: "applied"|"skipped"|"build_failed"|"reverted", title, diff_lines}`. Lets the next cycle see its own track record.
- [ ] **P2 / L — Allow the optimiser to edit prompts as well as code.** Following Letta's lead: the system prompt in `agent.ts` is at least as impactful as the surrounding code. Treat it as a first-class artefact (`prompts/system.md`) that the optimiser can rewrite under the same eval gate.
- [ ] **P2 / S — Notify the user via Telegram when a self-modification ships.** A short message ("vox: applied 'Add retry on 429' — [commit](url)") closes the loop and gives a kill switch by message.

---

## 3. Safety & sandboxing

The README labels this "YOLO mode" — fine for a personal machine, but the gaps matter the moment a second person touches it.

- [ ] **P0 / M — Move the agent's shell into a container or sandbox profile.** Even on a personal box. Bun runs fine inside Docker with `--cap-drop=ALL`, a bind-mount on `WORKSPACE`, and no host network. Same code, much smaller blast radius.
- [ ] **P1 / S — Drop the regex blocklist and document it as such.** The `BLOCKED_COMMANDS` list catches `rm -rf /` and a fork bomb but is trivial to bypass (`rm  -rf /`, `bash -c 'rm -rf /'`, `eval`, env-substituted paths). It's security theatre. Either remove it and document "this tool runs arbitrary shell as the host user", or replace with a real allow-list of approved commands.
- [ ] **P1 / S — Strict allow-list on what the optimiser is permitted to write.** Right now `vox/index.ts` writes whatever filename the model returned, joined onto `AGENT_DIR`. A hostile or confused model could write `../../etc/anything`. Validate the suggestion's `file` against an explicit allow-list (`["agent.ts", "tools.ts", "index.ts"]`) and reject otherwise.
- [ ] **P1 / S — Add a confirmation gate for high-risk shell commands.** Even in YOLO mode, certain command shapes (recursive delete, destructive `git`, `chmod -R`, `mv` outside `WORKSPACE`, `sudo`) warrant a Telegram approval prompt rather than immediate execution. A 30-second human-in-the-loop on the long tail of dangerous commands is cheap and dramatically reduces risk.
- [ ] **P1 / S — Don't push secrets in self-mod commits.** vox runs `git add <file>` then `git commit` then `git push`. There's no check that the new file content doesn't contain `DEEPSEEK_API_KEY` (or any other env value) inlined by mistake. Add a simple pre-commit scan.
- [ ] **P2 / M — Capability boundaries per chat.** Today every authorised user has the same all-tools access. A `/mode safe` command that disables `run_shell_command` and `write_file` for the next N turns gives a low-friction way to operate without YOLO when needed.
- [ ] **P2 / S — Document the trust model explicitly in the README.** Single Telegram user ID, `bun` running as the host user, no sandbox. Currently implied; should be stated.

---

## 4. Observability & developer ergonomics

- [ ] **P1 / S — Real logger (not `console.log` everywhere).** `pino` is one line of dependency, gives structured JSON, levels, and rotation. Replace ad-hoc `console.log("[Tool: …]")` with a tagged logger.
- [ ] **P1 / S — Rotate `history.jsonl` and `vox.log`.** Both grow without bound. `pino`'s built-in rotation, or a daily-rotation cron — but a 6-month-old file will become a problem.
- [ ] **P1 / S — Surface tool errors back to the user, not just to logs.** Several tool failure paths return `"Error: …"` strings that the model usually paraphrases or hides. Add a `🚨` prefix and propagate through the batcher.
- [ ] **P2 / S — Health endpoint.** A tiny HTTP server on `localhost:7700` exposing `/health` (agent up, last optimisation status, history size) makes external monitoring possible without grepping logs.
- [ ] **P2 / S — Consolidate config.** Three places consume env: `agent.ts`, `tools.ts`, `vox/index.ts`. A single `config.ts` that reads, validates (with `zod`), and re-exports a typed object is a cheap quality win.
- [ ] **P2 / M — Tests.** There are zero tests in the repo. Even three would be valuable: (a) `validateCommand` blocks the patterns it claims to, (b) `MessageBatcher` chunks at 4 000-char boundaries safely with emoji, (c) `Agent.runLoop` terminates on an empty tool-call response. These also seed the eval suite from §2.

---

## 5. Feature additions worth considering

- [ ] **P1 / M — Streaming responses to Telegram.** The DeepSeek API supports streaming. Combined with the batcher, this would let the user see partial output during long tool runs instead of waiting for the full reply.
- [ ] **P1 / M — Per-chat conversation memory.** Currently `Agent.history` is a single array shared across all chats (today fine because there's only one allowed user, but baking in the assumption costs nothing to fix). Key history by `chatId`.
- [ ] **P1 / S — `/undo` Telegram command.** Reverts the last self-modification (`git revert HEAD` if the most recent commit is a `vox:` commit). Pairs with the §3 notification feature to give the user a fast off-switch.
- [ ] **P2 / M — Move `inspect_ui_component` out of the core tool set.** It was clearly added for a specific Vue project and looks out of place in a general-purpose agent. Either generalise (any framework, real CSS parser) or move to a workspace-local plugin loaded from `WORKSPACE/.deepmore/tools/`. Treating tools as a pluggable surface (similar to MCP servers) opens up domain extensions without touching the core.
- [ ] **P2 / M — MCP server compatibility.** The tool registry in `tools.ts` is a hand-rolled JSON-schema list. Exposing it (or wrapping it) as an MCP server would let other clients reuse the same tools and let deepmore consume third-party MCP tools. This is where the broader agent ecosystem is converging in late 2025/2026.
- [ ] **P2 / L — Multi-model routing.** `DEEPSEEK_MODEL_ULTRA` is documented but unused (see §1). Use it: route obvious tool-glue turns to the cheap chat model, and escalate planning/diagnosis turns to the reasoner. The decision can be a heuristic on user intent or a tiny classifier.

---

## 6. Documentation

- [ ] **P1 / S — Replace `deepseek-agent/README.md`** (currently the boilerplate `bun init` template) with real content. Even a 30-line description of what the package does would help.
- [ ] **P2 / S — Architecture diagram in the root README.** `design.md` has it; the README doesn't.
- [ ] **P2 / S — A "self-optimisation" log in the repo.** Markdown file that vox appends to on every successful change, summarising what shipped. Acts as a human-readable changelog and a cross-check against git history.

---

## Suggested ordering

If picking only the top 5 to do first, in order:

1. Cap the tool-calling loop (§1) — pure safety net, ten-line change.
2. Validate the optimiser's `file` field against an allow-list (§3) — closes a real escape.
3. Add a minimal eval suite and gate the optimiser on it (§2) — the single biggest leverage point.
4. Move the agent process inside Docker with a workspace bind-mount (§3) — proportionate sandboxing.
5. Run optimisations on a `vox/auto/*` branch with a PR instead of pushing main (§2) — trivially aligns deepmore with current "agent-safe git" practice.
