#!/usr/bin/env bun
/**
 * vox — TUI wrapper for deepseek-agent
 *
 * - Runs the sub-agent as a child process
 * - Accepts prompts from stdin (interactive TUI)
 * - Every day at 04:00 local time: reviews last 24h history, generates
 *   optimization suggestions, implements the top-1 critical one, verifies
 *   it works, then git-pushes. Rolls back on failure.
 */

import { spawn, type Subprocess } from "bun";
import * as readline from "readline";
import * as fs from "fs/promises";
import * as path from "path";
import { config } from "dotenv";
import OpenAI from "openai";
import { appendHistory, readRecentHistory } from "../log/logger";

config({ path: path.join(import.meta.dir, "../deepseek-agent/.env") });

const AGENT_DIR = path.resolve(import.meta.dir, "../deepseek-agent");
const LOG_FILE = path.join(import.meta.dir, "vox.log");
const LOG_PREFIX = "[vox]";

function ts() {
  return new Date().toISOString();
}

async function log(msg: string) {
  const line = `${ts()} ${msg}\n`;
  process.stdout.write(line);
  await fs.appendFile(LOG_FILE, line);
}

// ── sub-agent process ────────────────────────────────────────────────────────

let agentProc: Subprocess | null = null;

function startAgent() {
  log(`${LOG_PREFIX} Starting deepseek-agent…`);
  agentProc = spawn(["bun", "run", "index.ts"], {
    cwd: AGENT_DIR,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  agentProc.exited.then((code) => {
    log(`${LOG_PREFIX} Agent exited (code ${code})`);
    agentProc = null;
  });
}

async function stopAgent() {
  if (agentProc) {
    agentProc.kill();
    await agentProc.exited;
    agentProc = null;
  }
}

async function restartAgent() {
  await stopAgent();
  startAgent();
}

// ── git helpers ──────────────────────────────────────────────────────────────

async function git(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = spawn(["git", ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { ok: code === 0, out: stdout + stderr };
}

async function currentCommit(): Promise<string> {
  const { out } = await git("rev-parse", "HEAD");
  return out.trim();
}

// ── self-optimisation ────────────────────────────────────────────────────────

async function runOptimisation() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    await log(`${LOG_PREFIX} DEEPSEEK_API_KEY not set — skipping optimisation`);
    return;
  }

  await log(`${LOG_PREFIX} [cron:04:00] Running daily optimisation…`);

  const history = await readRecentHistory();
  if (history.length === 0) {
    await log(`${LOG_PREFIX} [cron] No history in last 24h — skipping`);
    return;
  }

  const openai = new OpenAI({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  });

  // Read agent source files
  const [agentSrc, toolsSrc, indexSrc] = await Promise.all([
    fs.readFile(path.join(AGENT_DIR, "agent.ts"), "utf-8"),
    fs.readFile(path.join(AGENT_DIR, "tools.ts"), "utf-8"),
    fs.readFile(path.join(AGENT_DIR, "index.ts"), "utf-8"),
  ]);

  const historyText = history
    .map((e) => `[${new Date(e.ts).toISOString()}] [${e.kind}] ${e.text}`)
    .join("\n");

  // Step 1: analyse and pick top-1 improvement
  const analysisResp = await openai.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `You are a senior TypeScript engineer reviewing a Telegram bot agent.
Analyse the last 24h of user prompts and agent responses, identify the single most impactful improvement to the agent code, and output a JSON object with:
{
  "critical": true | false,   // true only if this is a clear, safe, high-value improvement
  "title": "short title",
  "description": "what to change and why",
  "file": "agent.ts" | "tools.ts" | "index.ts",
  "new_content": "complete new file content after the change"
}
If there is no critical improvement, set critical=false and omit new_content.`,
      },
      {
        role: "user",
        content: `## Recent interaction history\n${historyText}\n\n## agent.ts\n\`\`\`ts\n${agentSrc}\n\`\`\`\n\n## tools.ts\n\`\`\`ts\n${toolsSrc}\n\`\`\`\n\n## index.ts\n\`\`\`ts\n${indexSrc}\n\`\`\``,
      },
    ],
  });

  const raw = analysisResp.choices[0].message.content || "";

  // Extract JSON from the response (may be wrapped in markdown fences)
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    await log(`${LOG_PREFIX} [cron] Could not parse optimisation response — skipping`);
    return;
  }

  let suggestion: {
    critical: boolean;
    title: string;
    description: string;
    file?: string;
    new_content?: string;
  };
  try {
    suggestion = JSON.parse(jsonMatch[1]);
  } catch {
    await log(`${LOG_PREFIX} [cron] JSON parse error — skipping`);
    return;
  }

  if (!suggestion.critical || !suggestion.new_content || !suggestion.file) {
    await log(`${LOG_PREFIX} [cron] No critical improvement found: ${suggestion.title || "n/a"}`);
    return;
  }

  await log(`${LOG_PREFIX} [cron] Applying: ${suggestion.title}`);
  await log(`${LOG_PREFIX} [cron] ${suggestion.description}`);

  const targetFile = path.join(AGENT_DIR, suggestion.file);
  const prevCommit = await currentCommit();

  // Write the improved file
  await fs.writeFile(targetFile, suggestion.new_content, "utf-8");

  // Verify it compiles
  const check = spawn(["bun", "build", "--target=bun", "index.ts"], {
    cwd: AGENT_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const checkCode = await check.exited;

  if (checkCode !== 0) {
    const errOut = await new Response(check.stderr).text();
    await log(`${LOG_PREFIX} [cron] Build failed — rolling back\n${errOut}`);
    await git("reset", "--hard", prevCommit);
    return;
  }

  // Commit and push
  await git("add", `deepseek-agent/${suggestion.file}`);
  await git("commit", "-m", `vox: ${suggestion.title}`);
  const push = await git("push");
  if (!push.ok) {
    await log(`${LOG_PREFIX} [cron] Push failed: ${push.out}`);
  } else {
    await log(`${LOG_PREFIX} [cron] Pushed optimisation: ${suggestion.title}`);
  }

  // Restart agent with new code
  await restartAgent();
}

// ── 04:00 scheduler ──────────────────────────────────────────────────────────

function msUntil4am(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(4, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function schedule4am() {
  const delay = msUntil4am();
  log(`${LOG_PREFIX} Next optimisation in ${Math.round(delay / 60000)}m (04:00 local)`);
  setTimeout(async () => {
    await runOptimisation();
    schedule4am();
  }, delay);
}

// ── TUI ───────────────────────────────────────────────────────────────────────

async function runTUI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: "vox> ",
  });

  console.log("╔══════════════════════════════╗");
  console.log("║  vox — deepseek agent shell  ║");
  console.log("║  /quit  exit                 ║");
  console.log("║  /restart  restart agent     ║");
  console.log("║  /optimise  run now          ║");
  console.log("╚══════════════════════════════╝");

  startAgent();
  schedule4am();

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "/quit" || input === "/exit") {
      await log(`${LOG_PREFIX} [user] /quit`);
      await stopAgent();
      process.exit(0);
    } else if (input === "/restart") {
      await log(`${LOG_PREFIX} [user] /restart`);
      await restartAgent();
    } else if (input === "/optimise") {
      await log(`${LOG_PREFIX} [user] /optimise`);
      await runOptimisation();
    } else {
      // Log as vox user prompt for history analysis
      await appendHistory({ ts: Date.now(), kind: "vox_in", source: "vox", text: input });
      await log(`${LOG_PREFIX} [prompt] ${input}`);
    }

    rl.prompt();
  });

  rl.on("close", async () => {
    await stopAgent();
    process.exit(0);
  });
}

// ── entrypoint ────────────────────────────────────────────────────────────────

await runTUI();
