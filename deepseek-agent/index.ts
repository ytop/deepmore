import { Bot } from "grammy";
import { config } from "dotenv";
import { Agent } from "./agent";
import { appendHistory } from "../log/logger";
import { MessageBatcher } from "./batcher";

config(); // Load environment variables from .env

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;

if (!BOT_TOKEN) {
  console.error("Error: TELEGRAM_BOT_TOKEN is not set in .env");
  process.exit(1);
}

if (!DEEPSEEK_API_KEY) {
  console.error("Error: DEEPSEEK_API_KEY is not set in .env");
  process.exit(1);
}

if (!ALLOWED_USER_ID) {
  console.error("Error: ALLOWED_USER_ID is not set in .env. Use 0 to allow all users.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const batcher = new MessageBatcher(bot);
const agent = new Agent(DEEPSEEK_API_KEY, process.env.DEEPSEEK_BASE_URL);

// Wire structured logger
agent.setLogFn((entry) => appendHistory({ ...entry, ts: Date.now() }));

const allowedUserId = parseInt(ALLOWED_USER_ID, 10);

// Middleware for authorization
bot.use(async (ctx, next) => {
  if (allowedUserId !== 0 && ctx.from?.id !== allowedUserId) {
    console.log(`Unauthorized access attempt from User ID: ${ctx.from?.id}`);
    if (ctx.chat?.id) {
      batcher.enqueue(ctx.chat.id, "⛔️ Unauthorized access. You are not allowed to use this bot.");
    }
    return;
  }
  await next();
});

// Setup Agent notifications to send to Telegram
agent.setOnMessageCallback(async (msg: string, chatId?: number) => {
  try {
    const targetChatId = chatId ?? allowedUserId;
    if (targetChatId === 0) {
      console.warn("Attempted to send notification to chat ID 0. Skipping.");
      return;
    }
    batcher.enqueue(targetChatId, msg);
  } catch (err) {
    console.error("Failed to send notification to Telegram:", err);
  }
});

bot.command(["start", "help"], async (ctx) => {
  batcher.enqueue(ctx.chat.id, "👋 Hello! I am your local DeepSeek agent. I have YOLO access to your local machine.\n\nSend me a message to start working.\nUse /new or /reset to clear the session memory.");
});

bot.command(["new", "reset"], async (ctx) => {
  agent.resetMemory();
  batcher.enqueue(ctx.chat.id, "🧹 Session memory has been reset.");
});

bot.on("message:text", async (ctx) => {
  const userMessage = ctx.message.text;
  const chatId = ctx.chat.id;

  await ctx.replyWithChatAction("typing");

  try {
    const response = await agent.sendMessage(userMessage, "telegram", chatId);

    // Log outgoing reply
    await appendHistory({ ts: Date.now(), kind: "telegram_out", source: "telegram", text: response });

    batcher.enqueue(chatId, response);
  } catch (error: any) {
    console.error("Agent error:", error);
    batcher.enqueue(chatId, `❌ Error from agent: ${error.message}`);
  }
});

// Start the bot
bot.start({
  onStart: (botInfo) => {
    console.log(`🚀 Bot is up and running! @${botInfo.username}`);
    console.log(`🔒 Bound to user ID: ${allowedUserId}`);
  },
});

// Graceful shutdown
process.once("SIGINT", async () => {
  await batcher.flushAll();
  bot.stop();
});
process.once("SIGTERM", async () => {
  await batcher.flushAll();
  bot.stop();
});
