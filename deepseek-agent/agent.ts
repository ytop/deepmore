import OpenAI from "openai";
import { tools, toolRunner } from "./tools";
import type { HistoryEntry } from "../log/logger";

const DEFAULT_MAX_ITERATIONS = 25;
const MAX_ITERATIONS_LOWER_BOUND = 1;
const MAX_ITERATIONS_UPPER_BOUND = 1000;

export function resolveMaxIterations(): number {
  const raw = process.env.AGENT_MAX_ITERATIONS;
  if (raw === undefined) return DEFAULT_MAX_ITERATIONS;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_MAX_ITERATIONS;
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
export const RESOLVED_MAX_ITERATIONS = resolveMaxIterations();

type LogFn = (entry: Omit<HistoryEntry, "ts">) => void | Promise<void>;

export class Agent {
  private openai: OpenAI;
  private history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private onMessageCallback?: (msg: string, chatId?: number) => void | Promise<void>;
  private logFn?: LogFn;
  private readonly maxIterations: number;

  constructor(apiKey: string, baseURL?: string) {
    this.openai = new OpenAI({
      apiKey: apiKey,
      baseURL: baseURL || "https://api.deepseek.com",
    });
    this.maxIterations = RESOLVED_MAX_ITERATIONS;

    this.history.push({
      role: "system",
      content: `You are an AI assistant running locally on a user's machine. You have access to tools to read/write files and execute shell commands.
Execute tasks responsibly. You operate in YOLO mode, meaning tools run immediately without confirmation, so be careful with shell commands. Keep responses concise.${process.env.WORKSPACE ? `\nYour primary workspace is: ${process.env.WORKSPACE}` : ""}`,
    });
  }

  public setOnMessageCallback(cb: (msg: string, chatId?: number) => void | Promise<void>) {
    this.onMessageCallback = cb;
  }

  public setLogFn(fn: LogFn) {
    this.logFn = fn;
  }

  public resetMemory() {
    this.history = [this.history[0] as OpenAI.Chat.ChatCompletionMessageParam]; // keep only system prompt
  }

  public async sendMessage(message: string, source: HistoryEntry["source"] = "telegram", chatId?: number): Promise<string> {
    this.history.push({ role: "user", content: message });
    await this.emit({ kind: source === "telegram" ? "telegram_in" : "vox_in", source, text: message });
    return this.runLoop(source, chatId);
  }

  private async emit(entry: Omit<HistoryEntry, "ts">) {
    if (this.logFn) await this.logFn(entry);
  }

  private async notifyUser(msg: string, chatId?: number) {
    if (this.onMessageCallback) await this.onMessageCallback(msg, chatId);
  }

  private async runLoop(source: HistoryEntry["source"], chatId?: number): Promise<string> {
    const model = process.env.DEEPSEEK_MODEL_BASE || "deepseek-chat";
    let attempt = 0;

    while (true) {
      attempt++;

      if (attempt > 1) {
        // Only log retry, don't spam user
        await this.emit({ kind: "retry", source, text: `Loop iteration ${attempt}`, meta: { attempt, model } });
      }

      const response = await this.openai.chat.completions.create({
        model,
        messages: this.history,
        tools: tools as any,
        tool_choice: "auto",
      });

      const message = response.choices[0]?.message!
      this.history.push(message as any);

      if (message.tool_calls && message.tool_calls.length > 0) {
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
        for (const toolCall of message.tool_calls) {
          const functionName = (toolCall as any).function.name as keyof typeof toolRunner;
          const args = JSON.parse((toolCall as any).function.arguments);

          await this.emit({ kind: "tool_call", source, text: functionName, meta: { args } });
          await this.notifyUser(`🛠 Running tool: ${functionName}\nArgs: ${JSON.stringify(args, null, 2)}`, chatId);

          let result: string;
          if (toolRunner[functionName]) {
            result = await toolRunner[functionName](args);
          } else {
            result = `Error: Tool ${functionName} not found.`;
          }

          this.history.push({ role: "tool", tool_call_id: toolCall.id, content: result });

          await this.emit({ kind: "tool_result", source, text: result, meta: { tool: functionName } });
          await this.notifyUser(`✅ Tool finished: ${functionName}\n${result.substring(0, 100)}...`, chatId);
        }
        // Loop continues — this is the think/re-do cycle
      } else {
        const reply = message.content || "";
        await this.emit({ kind: "model_reply", source, text: reply, meta: { model, attempt } });
        return reply;
      }
    }
  }
}
