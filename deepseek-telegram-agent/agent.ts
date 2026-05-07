import OpenAI from "openai";
import { tools, toolRunner } from "./tools";

export class Agent {
  private openai: OpenAI;
  private history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private onMessageCallback?: (msg: string) => void | Promise<void>;

  constructor(apiKey: string, baseURL?: string) {
    this.openai = new OpenAI({
      apiKey: apiKey,
      baseURL: baseURL || "https://api.deepseek.com", // default to deepseek
    });

    this.history.push({
      role: "system",
      content: `You are an AI assistant running locally on a user's machine. You have access to tools to read/write files and execute shell commands.
Execute tasks responsibly. You operate in YOLO mode, meaning tools run immediately without confirmation, so be careful with shell commands. Keep responses concise.${process.env.WORKSPACE ? `\nYour primary workspace is: ${process.env.WORKSPACE}` : ""}`,
    });
  }

  public setOnMessageCallback(cb: (msg: string) => void | Promise<void>) {
    this.onMessageCallback = cb;
  }

  public resetMemory() {
    this.history = [this.history[0]]; // keep only system prompt
  }

  public async sendMessage(message: string): Promise<string> {
    this.history.push({ role: "user", content: message });
    return this.runLoop();
  }

  private async notifyUser(msg: string) {
    if (this.onMessageCallback) {
      await this.onMessageCallback(msg);
    }
  }

  private async runLoop(): Promise<string> {
    while (true) {
      const response = await this.openai.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL_BASE || "deepseek-chat",
        messages: this.history,
        tools: tools as any,
        tool_choice: "auto",
      });

      const message = response.choices[0].message;
      this.history.push(message as any);

      if (message.tool_calls && message.tool_calls.length > 0) {
        let toolResults: string[] = [];
        for (const toolCall of message.tool_calls) {
          const functionName = toolCall.function.name as keyof typeof toolRunner;
          const args = JSON.parse(toolCall.function.arguments);

          await this.notifyUser(`🛠 Running tool: ${functionName}\nArgs: ${JSON.stringify(args, null, 2)}`);

          let result: string;
          if (toolRunner[functionName]) {
             result = await toolRunner[functionName](args);
          } else {
             result = `Error: Tool ${functionName} not found.`;
          }

          this.history.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });

          toolResults.push(`Result of ${functionName}: ${result.substring(0, 100)}...`);
        }

        await this.notifyUser(`✅ Tool(s) finished.\n${toolResults.join('\n')}`);
        // Loop continues
      } else {
        return message.content || "";
      }
    }
  }
}
