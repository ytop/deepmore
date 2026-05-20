/**
 * Lark channel — connects the shared Agent to a Lark bot via WebSocket
 * long-connection (no public URL required).
 *
 * Uses @larksuiteoapi/node-sdk's WSClient for event subscription and
 * Client for sending messages.
 */

import * as lark from "@larksuiteoapi/node-sdk";
import { Agent } from "./agent";
import { appendHistory } from "../log/logger";

export interface LarkChannelOptions {
  appId: string;
  appSecret: string;
  agent: Agent;
}

export class LarkChannel {
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private agent: Agent;

  constructor(opts: LarkChannelOptions) {
    this.agent = opts.agent;

    this.client = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: lark.Domain.Lark,
    });

    this.wsClient = new lark.WSClient({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: lark.Domain.Lark,
      loggerLevel: lark.LoggerLevel.info,
    });
  }

  /**
   * Start listening for Lark messages via WebSocket long-connection.
   */
  public async start() {
    this.wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
          await this.handleMessage(data);
        },
      }),
    });

    console.log("🔗 Lark channel connected (WebSocket long-connection)");
  }

  private async handleMessage(data: any) {
    const message = data.message;
    if (!message) return;

    // Only handle text messages for now
    const msgType = message.message_type;
    if (msgType !== "text") return;

    const chatId = message.chat_id;
    let text: string;
    try {
      const content = JSON.parse(message.content);
      text = content.text;
    } catch {
      return;
    }

    if (!text || !text.trim()) return;

    // Strip @mention prefix if present (Lark prepends @_user_1 etc.)
    const cleaned = text.replace(/@_user_\d+\s*/g, "").trim();
    if (!cleaned) return;

    try {
      const response = await this.agent.sendMessage(cleaned, "lark", chatId);

      // Log outgoing reply
      await appendHistory({ ts: Date.now(), kind: "lark_out", source: "lark", text: response });

      // Send reply back to Lark
      await this.sendMessage(chatId, response);
    } catch (error: any) {
      console.error("Lark agent error:", error);
      await this.sendMessage(chatId, `❌ Error from agent: ${error.message}`);
    }
  }

  /**
   * Send a text message to a Lark chat. Splits long messages into 4000-char chunks.
   */
  public async sendMessage(chatId: string, text: string) {
    const chunkSize = 4000;
    const chars = Array.from(text);

    for (let i = 0; i < chars.length; i += chunkSize) {
      const chunk = chars.slice(i, i + chunkSize).join("");
      try {
        await this.client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ text: chunk }),
            msg_type: "text",
          },
        });
      } catch (err) {
        console.error(`Failed to send Lark message to chat ${chatId}:`, err);
      }
    }
  }
}
