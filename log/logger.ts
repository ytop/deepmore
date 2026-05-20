import * as fs from "fs/promises";
import * as path from "path";

export const HISTORY_FILE = path.join(import.meta.dir, "history.jsonl");

export type EventKind =
  | "telegram_in"    // user message received via Telegram
  | "telegram_out"   // bot reply sent to Telegram
  | "lark_in"        // user message received via Lark
  | "lark_out"       // bot reply sent to Lark
  | "vox_in"         // user input typed in vox TUI
  | "model_reply"    // raw model text response
  | "tool_call"      // agent invoked a tool
  | "tool_result"    // tool execution result
  | "retry"          // model loop iteration (think/re-do)
  | "loop_cap";      // loop terminated by iteration cap

export interface HistoryEntry {
  ts: number;        // unix ms
  kind: EventKind;
  source: "telegram" | "vox" | "lark";
  text: string;
  meta?: Record<string, unknown>; // e.g. tool name, model name, attempt number
}

export async function appendHistory(entry: HistoryEntry): Promise<void> {
  await fs.appendFile(HISTORY_FILE, JSON.stringify(entry) + "\n");
}

export async function readRecentHistory(windowMs = 24 * 60 * 60 * 1000): Promise<HistoryEntry[]> {
  try {
    const raw = await fs.readFile(HISTORY_FILE, "utf-8");
    const cutoff = Date.now() - windowMs;
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryEntry)
      .filter((e) => e.ts >= cutoff);
  } catch {
    return [];
  }
}
