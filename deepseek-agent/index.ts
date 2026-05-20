import { Bot } from "grammy";
import { config } from "dotenv";
import { Agent } from "./agent";
import { appendHistory } from "../log/logger";
import { MessageBatcher } from "./batcher";
import { LarkChannel } from "./lark";

config(); // Load environment variables from .env

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;

if (!BOT_TOKEN && !LARK_APP_ID) {
  console.error("Error: At least one channel must be configured (TELEGRAM_BOT_TOKEN or LARK_APP_ID + LARK_APP_SECRET)");
  process.exit(1);
}

if (!DEEPSEEK_API_KEY) {
  console.error("Error: DEEPSEEK_API_KEY is not set in .env");
  process.exit(1);
}

if (BOT_TOKEN && !ALLOWED_USER_ID) {
  console.error("Error: ALLOWED_USER_ID is not set in .env. Use 0 to allow all users.");
  process.exit(1);
}

const agent = new Agent(DEEPSEEK_API_KEY, process.env.DEEPSEEK_BASE_URL);

// Wire structured logger
agent.setLogFn((entry) => appendHistory({ ...entry, ts: Date.now() }));

const allowedUserId = ALLOWED_USER_ID ? parseInt(ALLOWED_USER_ID, 10) : 0;

// ── Telegram channel ─────────────────────────────────────────────────────────

let bot: Bot | undefined;
let batcher: MessageBatcher | undefined;

if (BOT_TOKEN) {
  bot = new Bot(BOT_TOKEN);
  batcher = new MessageBatcher(bot);

  // Middleware for authorization
  bot.use(async (ctx, next) => {
    if (allowedUserId !== 0 && ctx.from?.id !== allowedUserId) {
      console.log(`Unauthorized access attempt from User ID: ${ctx.from?.id}`);
      if (ctx.chat?.id) {
        batcher!.enqueue(ctx.chat.id, "⛔️ Unauthorized access. You are not allowed to use this bot.");
      }
      return;
    }
    await next();
  });

  bot.command(["start", "help"], async (ctx) => {
    batcher!.enqueue(ctx.chat.id, "👋 Hello! I am your local DeepSeek agent. I have YOLO access to your local machine.\n\nSend me a message to start working.\nUse /new or /reset to clear the session memory.");
  });

  bot.command(["new", "reset"], async (ctx) => {
    agent.resetMemory();
    batcher!.enqueue(ctx.chat.id, "🧹 Session memory has been reset.");
  });

  bot.on("message:text", async (ctx) => {
    const userMessage = ctx.message.text;
    const chatId = ctx.chat.id;

    await ctx.replyWithChatAction("typing");

    try {
      const response = await agent.sendMessage(userMessage, "telegram", chatId);

      // Log outgoing reply
      await appendHistory({ ts: Date.now(), kind: "telegram_out", source: "telegram", text: response });

      batcher!.enqueue(chatId, response);
    } catch (error: any) {
      console.error("Agent error:", error);
      batcher!.enqueue(chatId, `❌ Error from agent: ${error.message}`);
    }
  });

  // Start the bot
  bot.start({
    onStart: (botInfo) => {
      console.log(`🚀 Telegram bot is up! @${botInfo.username}`);
      console.log(`🔒 Bound to user ID: ${allowedUserId}`);
    },
  });
}

// ── Lark channel ─────────────────────────────────────────────────────────────

let larkChannel: LarkChannel | undefined;

if (LARK_APP_ID && LARK_APP_SECRET) {
  larkChannel = new LarkChannel({
    appId: LARK_APP_ID,
    appSecret: LARK_APP_SECRET,
    agent,
  });
  await larkChannel.start();
}

// ── Agent notifications ──────────────────────────────────────────────────────

// Route agent notifications to the appropriate channel based on chatId type
agent.setOnMessageCallback(async (msg: string, chatId?: number | string) => {
  try {
    if (typeof chatId === "string" && larkChannel) {
      // Lark chat IDs are strings
      await larkChannel.sendMessage(chatId, msg);
    } else if (batcher) {
      // Telegram chat IDs are numbers
      const targetChatId = (chatId as number) ?? allowedUserId;
      if (targetChatId === 0) {
        console.warn("Attempted to send notification to chat ID 0. Skipping.");
        return;
      }
      batcher.enqueue(targetChatId, msg);
    }
  } catch (err) {
    console.error("Failed to send notification:", err);
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

process.once("SIGINT", async () => {
  if (batcher) await batcher.flushAll();
  if (bot) bot.stop();
});
process.once("SIGTERM", async () => {
  if (batcher) await batcher.flushAll();
  if (bot) bot.stop();
});
