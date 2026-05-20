// TEST-ONLY fixture: pre-feature runLoop reference for cap-agent-tool-loop Property 4. Do not import from production code.

import type OpenAI from "openai";
import type { HistoryEntry } from "../log/logger";

type EmitFn = (entry: Omit<HistoryEntry, "ts">) => void | Promise<void>;
type NotifyFn = (msg: string, chatId?: number) => void | Promise<void>;
type ToolRunner = Record<string, (args: any) => string | Promise<string>>;

// Minimal structural shape of the OpenAI client used inside the loop.
// Accepts both the real `OpenAI` instance and a hand-rolled mock.
export interface OpenAILike {
  chat: {
    completions: {
      create: (args: {
        model: string;
        messages: OpenAI.Chat.ChatCompletionMessageParam[];
        tools: any;
        tool_choice: "auto";
      }) => Promise<OpenAI.Chat.ChatCompletion>;
    };
  };
}

export interface RunLegacyLoopDeps {
  openai: OpenAILike;
  history: OpenAI.Chat.ChatCompletionMessageParam[];
  model: string;
  tools: any;
  toolRunner: ToolRunner;
  emit: EmitFn;
  notifyUser: NotifyFn;
  source: HistoryEntry["source"];
  chatId?: number;
}

/**
 * Pre-feature `Agent.runLoop` body, extracted verbatim as a standalone async
 * function for use as the reference implementation in property tests
 * (Property 4: below-cap behaviour matches the pre-feature implementation).
 *
 * Differences from `Agent.runLoop` in `agent.ts`:
 *   - No iteration cap branch.
 *   - No `loop_cap` event emission.
 *   - No `maxIterations` field; takes all collaborators as explicit `deps`.
 *
 * Otherwise byte-for-byte semantically identical to the pre-feature loop:
 *   - `attempt` starts at 0 and is incremented at the top of each iteration.
 *   - On `attempt > 1`, emits `retry` before any other action.
 *   - Calls `chat.completions.create` with `{ model, messages: history, tools, tool_choice: "auto" }`.
 *   - Pushes the assistant message into `history` as-is.
 *   - On `tool_calls`: emits `tool_call`, notifies user with start message,
 *     runs tool (or "Error: Tool ${name} not found." if missing), pushes a
 *     `{ role: "tool", tool_call_id, content }` entry, emits `tool_result`,
 *     notifies user with the truncated finish message.
 *   - On no `tool_calls`: emits `model_reply` and returns the model reply text.
 */
export async function runLegacyLoop(deps: RunLegacyLoopDeps): Promise<string> {
  const { openai, history, model, tools, toolRunner, emit, notifyUser, source, chatId } = deps;
  let attempt = 0;

  while (true) {
    attempt++;

    if (attempt > 1) {
      // Only log retry, don't spam user
      await emit({ kind: "retry", source, text: `Loop iteration ${attempt}`, meta: { attempt, model } });
    }

    const response = await openai.chat.completions.create({
      model,
      messages: history,
      tools: tools as any,
      tool_choice: "auto",
    });

    const message = response.choices[0]?.message!;
    history.push(message as any);

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        const functionName = (toolCall as any).function.name as string;
        const args = JSON.parse((toolCall as any).function.arguments);

        await emit({ kind: "tool_call", source, text: functionName, meta: { args } });
        await notifyUser(`🛠 Running tool: ${functionName}\nArgs: ${JSON.stringify(args, null, 2)}`, chatId);

        let result: string;
        if (toolRunner[functionName]) {
          result = await toolRunner[functionName](args);
        } else {
          result = `Error: Tool ${functionName} not found.`;
        }

        history.push({ role: "tool", tool_call_id: toolCall.id, content: result });

        await emit({ kind: "tool_result", source, text: result, meta: { tool: functionName } });
        await notifyUser(`✅ Tool finished: ${functionName}\n${result.substring(0, 100)}...`, chatId);
      }
      // Loop continues — this is the think/re-do cycle
    } else {
      const reply = message.content || "";
      await emit({ kind: "model_reply", source, text: reply, meta: { model, attempt } });
      return reply;
    }
  }
}
