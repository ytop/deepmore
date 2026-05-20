import { Bot } from "grammy";

export class MessageBatcher {
  private queues: Map<number, string[]> = new Map();
  private timers: Map<number, ReturnType<typeof setTimeout>> = new Map();
  private typingIntervals: Map<number, ReturnType<typeof setInterval>> = new Map();
  private bot: Bot;
  private readonly delayMs = 10000;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  public enqueue(chatId: number, message: string) {
    if (!this.queues.has(chatId)) {
      this.queues.set(chatId, []);
    }

    this.queues.get(chatId)!.push(message);

    this.startTimerIfNotRunning(chatId);
    this.ensureTypingIndicator(chatId);
  }

  private startTimerIfNotRunning(chatId: number) {
    if (!this.timers.has(chatId)) {
      this.timers.set(
        chatId,
        setTimeout(() => this.flush(chatId), this.delayMs)
      );
    }
  }

  private ensureTypingIndicator(chatId: number) {
    // Send initially, then every 5 seconds to keep it active
    if (!this.typingIntervals.has(chatId)) {
      this.bot.api.sendChatAction(chatId, "typing").catch(console.error);
      this.typingIntervals.set(
        chatId,
        setInterval(() => {
          this.bot.api.sendChatAction(chatId, "typing").catch(console.error);
        }, 5000)
      );
    }
  }

  private stopTypingIndicator(chatId: number) {
    if (this.typingIntervals.has(chatId)) {
      clearInterval(this.typingIntervals.get(chatId)!);
      this.typingIntervals.delete(chatId);
    }
  }

  public async flush(chatId: number) {
    if (this.timers.has(chatId)) {
      clearTimeout(this.timers.get(chatId)!);
      this.timers.delete(chatId);
    }
    this.stopTypingIndicator(chatId);

    const messages = this.queues.get(chatId);
    if (!messages || messages.length === 0) return;

    this.queues.delete(chatId);

    const mergedMessage = messages.join("\n==========\n");

    const chunkSize = 4000;

    // Use Array.from for emoji safety when slicing
    const chars = Array.from(mergedMessage);

    for (let i = 0; i < chars.length; i += chunkSize) {
      const chunk = chars.slice(i, i + chunkSize).join('');
      try {
        await this.bot.api.sendMessage(chatId, chunk);
      } catch (err) {
        console.error(`Failed to send message to chat ${chatId}:`, err);
      }
    }
  }

  public async flushAll() {
    const promises: Promise<void>[] = [];
    for (const chatId of this.queues.keys()) {
      promises.push(this.flush(chatId));
    }
    await Promise.all(promises);
  }
}
