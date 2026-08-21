// Thin wrapper over the Telegram Bot API endpoints Genosuke needs beyond
// notifyTelegram.ts's plain sendMessage (getUpdates polling, inline-keyboard
// confirmations, answering callback queries). Uses fetch, not axios —
// matches this project's existing convention (notifyTelegram.ts), unlike
// menaris-admin-api's Jack which uses axios.
const MESSAGE_LIMIT = 4096;
const TRUNCATED_SUFFIX = "... (message truncated)";

function truncate(text: string): string {
  if (text.length <= MESSAGE_LIMIT) return text;
  return `${text.slice(0, MESSAGE_LIMIT - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    entities?: { type: string; offset: number; length: number }[];
    chat: { id: number; type: string };
    from?: { id: number; is_bot: boolean };
    reply_to_message?: { message_id: number; from?: { id: number }; text?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
  };
}

export class TelegramApi {
  private readonly base: string;

  constructor(botToken: string) {
    this.base = `https://api.telegram.org/bot${botToken}`;
  }

  async getMe(): Promise<{ id: number; username: string }> {
    const response = await fetch(`${this.base}/getMe`);
    const json = (await response.json()) as { result: { id: number; username: string } };
    return json.result;
  }

  async deleteWebhook(): Promise<void> {
    await fetch(`${this.base}/deleteWebhook`, { method: "POST" }).catch(() => {});
  }

  async getUpdates(offset: number, timeoutSeconds: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams({
      offset: String(offset),
      timeout: String(timeoutSeconds),
      allowed_updates: JSON.stringify(["message", "callback_query"]),
    });
    const response = await fetch(`${this.base}/getUpdates?${params.toString()}`, { signal });
    const json = (await response.json()) as { result: TelegramUpdate[] };
    return json.result ?? [];
  }

  async peekLatestUpdateId(): Promise<number | null> {
    const params = new URLSearchParams({ offset: "-1", limit: "1" });
    const response = await fetch(`${this.base}/getUpdates?${params.toString()}`);
    const json = (await response.json()) as { result: TelegramUpdate[] };
    return json.result?.[0]?.update_id ?? null;
  }

  async sendMessage(chatId: string, text: string, options: { replyToMessageId?: number; buttons?: TelegramInlineButton[][] } = {}): Promise<void> {
    try {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: truncate(text),
        disable_web_page_preview: true,
      };
      if (options.replyToMessageId) {
        body.reply_to_message_id = options.replyToMessageId;
        body.allow_sending_without_reply = true;
      }
      if (options.buttons) body.reply_markup = { inline_keyboard: options.buttons };

      const response = await fetch(`${this.base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) console.warn(`Genosuke: sendMessage failed (${response.status}): ${await response.text()}`);
    } catch (error) {
      // A Telegram-side failure here must never become an unhandled
      // rejection — this project has no global unhandledRejection handler
      // (see PROGRESS.md), so an uncaught one would crash the whole API
      // process, not just the bot.
      console.warn("Genosuke: sendMessage failed", error instanceof Error ? error.message : error);
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await fetch(`${this.base}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      });
    } catch (error) {
      console.warn("Genosuke: answerCallbackQuery failed", error instanceof Error ? error.message : error);
    }
  }
}
