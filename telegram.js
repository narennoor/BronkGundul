import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { writeJsonAtomic } from "./utils/json-store.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

// ─── Forum-topic routing ─────────────────────────────────────────
// In a group with Topics enabled every send can target a topic via
// message_thread_id. Cycle activity and cron reports get fixed topics from
// .env (TELEGRAM_TOPIC_ACTIVITY / TELEGRAM_TOPIC_REPORT); command replies
// echo into the topic the command was typed in (setReplyThread, set per
// incoming message). Anything unset/null lands in the General topic — and in
// a plain private/group chat no thread is ever attached, so behavior there
// is unchanged.
function parseTopicId(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}
export const TOPICS = {
  activity: parseTopicId(process.env.TELEGRAM_TOPIC_ACTIVITY),
  report: parseTopicId(process.env.TELEGRAM_TOPIC_REPORT),
};
let _replyThreadId = null;
export function setReplyThread(threadId) {
  _replyThreadId = parseTopicId(threadId);
}
// Only these methods accept message_thread_id; edits and callback answers
// target a message_id and need no thread.
const THREAD_METHODS = new Set(["sendMessage", "sendChatAction"]);
// undefined = caller didn't choose → follow the reply context; explicit
// null = force General; a number = that topic.
function resolveThread(thread) {
  return thread !== undefined ? thread : _replyThreadId;
}

// ─── Mention gate for groups ─────────────────────────────────────
// In a group every message from an allowed user used to reach the LLM, so
// ordinary chat between members burned agent turns. Now free-form text in a
// group/supergroup is handled only when it addresses the bot: an @mention
// of the bot, or a reply to one of the bot's messages. Slash commands and
// inline-button presses are always handled (a command addressed to ANOTHER
// bot, `/status@OtherBot`, is dropped). Private chats are untouched. Set
// TELEGRAM_REQUIRE_MENTION=false to restore the old behaviour.
const REQUIRE_MENTION_IN_GROUPS =
  String(process.env.TELEGRAM_REQUIRE_MENTION ?? "true").trim().toLowerCase() !== "false";
let _botUsername = null; // from getMe, without the leading "@"
let _botId = null;

/**
 * Decide whether an inbound text message is addressed to this bot and
 * return the text with the bot's own @mention stripped, so `@Bot status?`
 * reaches the handler as `status?` and `/status@Bot` as `/status`.
 * Pure — exported for unit tests.
 */
export function prepareIncomingText(msg, { botUsername = _botUsername, botId = _botId, requireMention = REQUIRE_MENTION_IN_GROUPS } = {}) {
  const raw = String(msg?.text ?? "");
  const chatType = msg?.chat?.type || "unknown";
  const isGroup = chatType === "group" || chatType === "supergroup";
  const uname = botUsername ? String(botUsername).replace(/^@/, "").toLowerCase() : null;
  const isOwnMention = (token) => uname != null && String(token).replace(/^@/, "").toLowerCase() === uname;

  // Slash command: `/cmd@SomeBot ...` — Telegram fans commands out to every
  // bot in the group, so only answer the ones addressed to us (or to nobody).
  const cmd = raw.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(\s[\s\S]*)?$/);
  if (cmd) {
    const [, name, target, rest = ""] = cmd;
    if (target && !isOwnMention(target)) return { accept: false, text: raw, reason: "command_for_other_bot" };
    return { accept: true, text: `/${name}${rest}`.trim() };
  }

  if (!isGroup || !requireMention) return { accept: true, text: raw.trim() };

  const entities = Array.isArray(msg?.entities) ? msg.entities : [];
  const mentionSpans = [];
  let mentioned = false;
  for (const ent of entities) {
    if (ent.type === "mention") {
      const token = raw.slice(ent.offset, ent.offset + ent.length);
      if (isOwnMention(token)) { mentioned = true; mentionSpans.push(ent); }
    } else if (ent.type === "text_mention" && botId != null && String(ent.user?.id) === String(botId)) {
      mentioned = true;
      mentionSpans.push(ent);
    }
  }
  // Entities can be absent (older clients, forwarded text) — fall back to a
  // plain token scan for @username.
  if (!mentioned && uname) {
    const re = new RegExp(`(^|\\s)@${uname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Za-z0-9_])`, "i");
    if (re.test(raw)) mentioned = true;
  }
  const replyFromId = msg?.reply_to_message?.from?.id;
  if (!mentioned && botId != null && replyFromId != null && String(replyFromId) === String(botId)) mentioned = true;

  if (!mentioned) return { accept: false, text: raw, reason: "not_mentioned" };

  // Strip our own @mention(s) so the LLM goal reads naturally.
  // Entity offsets are UTF-16 code units, same as JS string indices.
  let text = raw;
  if (mentionSpans.length) {
    text = "";
    let cursor = 0;
    for (const ent of [...mentionSpans].sort((a, b) => a.offset - b.offset)) {
      text += raw.slice(cursor, ent.offset);
      cursor = ent.offset + ent.length;
    }
    text += raw.slice(cursor);
  }
  if (uname) text = text.replace(new RegExp(`(^|\\s)@${uname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Za-z0-9_])`, "gi"), "$1");
  text = text.replace(/\s{2,}/g, " ").trim();
  return { accept: true, text };
}

async function fetchBotIdentity() {
  if (!BASE) return false;
  try {
    const res = await tgFetch(`${BASE}/getMe`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data?.ok || !data.result?.username) return false;
    _botUsername = data.result.username;
    _botId = data.result.id;
    log("telegram", `Bot identity: @${_botUsername} (id ${_botId}); group mention gate ${REQUIRE_MENTION_IN_GROUPS ? "ON" : "OFF"}`);
    return true;
  } catch (e) {
    log("telegram_warn", `getMe failed: ${e.message}`);
    return false;
  }
}

let chatId = null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── Optional Telegram-only proxy ────────────────────────────────
// Some ISPs block api.telegram.org at the network level (DPI/IP block) while
// the rest of the internet works. Set TELEGRAM_PROXY_URL in .env (e.g.
// http://user:pass@host:port) to route ONLY bot traffic through an HTTP(S)
// CONNECT proxy — RPC and pool API calls stay on the direct path. Uses
// undici's own fetch with its ProxyAgent (mixing the npm ProxyAgent into the
// built-in fetch is unreliable across versions). Lazy-init on first call;
// falls back to a direct connection if the proxy can't be constructed.
let _tgProxy; // undefined = not initialized, null = disabled/failed, else {fetch, dispatcher}

async function tgFetch(url, init = {}) {
  const proxyUrl = process.env.TELEGRAM_PROXY_URL;
  if (!proxyUrl) return fetch(url, init);
  if (_tgProxy === undefined) {
    try {
      const { fetch: undiciFetch, ProxyAgent } = await import("undici");
      _tgProxy = { fetch: undiciFetch, dispatcher: new ProxyAgent(proxyUrl) };
      log("telegram", `Telegram traffic routed via proxy ${new URL(proxyUrl).host}`);
    } catch (e) {
      _tgProxy = null;
      log("telegram_warn", `TELEGRAM_PROXY_URL set but proxy init failed (${e.message}); using direct connection`);
    }
  }
  if (!_tgProxy) return fetch(url, init);
  return _tgProxy.fetch(url, { ...init, dispatcher: _tgProxy.dispatcher });
}

function nonEmptyChatId(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

// ─── chatId persistence ──────────────────────────────────────────
function resolveChatId() {
  const fromEnv = nonEmptyChatId(process.env.TELEGRAM_CHAT_ID);
  let fromConfig = null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      fromConfig = nonEmptyChatId(cfg.telegramChatId);
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
  // user-config wins when set; otherwise fall back to .env
  const resolved = fromConfig || fromEnv || null;
  return resolved != null ? String(resolved) : null;
}

function loadChatId() {
  chatId = resolveChatId();
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    writeJsonAtomic(USER_CONFIG_PATH, cfg);
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== String(chatId)) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body, thread) {
  if (!TOKEN || !chatId) return null;
  const threadId = resolveThread(thread);
  const payload = { chat_id: chatId, ...body };
  if (threadId != null && THREAD_METHODS.has(method)) payload.message_thread_id = threadId;
  try {
    const res = await tgFetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await tgFetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text, { thread } = {}) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) }, thread);
}

// ─── Markdown → Telegram HTML ────────────────────────────────────
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Telegram has no markdown-compatible parse mode for LLM output (**bold**,
// ### headings), so convert the common constructs to Telegram HTML.
export function markdownToTelegramHtml(text) {
  const stash = [];
  // NUL sentinels cannot occur in LLM/user text, so stashed HTML is never clobbered
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let out = String(text).replace(/\u0000/g, "");
  out = out.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) =>
    keep(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`));
  out = escapeHtml(out);
  out = out.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  return out;
}

/** Send markdown-ish LLM output as formatted HTML; falls back to plain text on parse failure. */
export async function sendMarkdown(text, { thread } = {}) {
  if (!TOKEN || !chatId) return;
  const plain = String(text).slice(0, 4096);
  const html = markdownToTelegramHtml(plain);
  if (html.length <= 4096) {
    const sent = await postTelegram("sendMessage", { text: html, parse_mode: "HTML" }, thread);
    if (sent) return sent;
  }
  return postTelegram("sendMessage", { text: plain }, thread);
}

export async function sendMessageWithButtons(text, inlineKeyboard, { thread } = {}) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  }, thread);
}

export async function sendHTML(html, { thread } = {}) {
  if (!TOKEN || !chatId) return;
  const text = String(html).slice(0, 4096);
  const sent = await postTelegram("sendMessage", { text, parse_mode: "HTML" }, thread);
  if (sent) return sent;
  // Parse failure (unescaped < in dynamic text, etc.) — degrade to plain text
  // instead of dropping the message entirely.
  const plain = text
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return postTelegram("sendMessage", { text: plain }, thread);
}

// MIME per ekstensi untuk sendDocument — Telegram menyimpan tipe ini dan
// klien memakainya saat membuka; ekstensi tak dikenal jatuh ke octet-stream.
const DOCUMENT_MIME = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
};

/**
 * Send a file as a Telegram document (multipart/form-data) — the report
 * attachments (XLSX workbook since fase 7; CSV still supported). Uses Node
 * 22's global FormData/Blob (no dependency); fetch writes the multipart
 * boundary itself, so no Content-Type header here. Caption max 1024 chars
 * (Telegram limit), document max 50 MB — the workbooks are tens of KB.
 * Returns the API result or null; a failed document must never take the text
 * report down with it, so this never throws.
 */
export async function sendDocument(buffer, filename, caption = "", { thread } = {}) {
  if (!TOKEN || !chatId) return null;
  try {
    const ext = String(filename).toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    const type = DOCUMENT_MIME[ext] ?? "application/octet-stream";
    const form = new FormData();
    form.append("chat_id", String(chatId));
    const threadId = resolveThread(thread);
    if (threadId != null) form.append("message_thread_id", String(threadId));
    if (caption) form.append("caption", String(caption).slice(0, 1024));
    form.append("document", new Blob([buffer], { type }), String(filename));
    const res = await tgFetch(`${BASE}/sendDocument`, { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendDocument ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `sendDocument failed: ${e.message}`);
    return null;
  }
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator(thread) {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" }, thread);
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...", { thread } = {}) {
  if (!TOKEN || !chatId) return null;
  // Resolve once at creation: a live message follows one topic for its whole
  // lifetime, even when the reply context moves on mid-cycle.
  const threadId = resolveThread(thread);
  const typing = createTypingIndicator(threadId);

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    const html = markdownToTelegramHtml(text);
    const formatted = html.length <= 4096 ? html : null;
    if (!state.messageId) {
      let sent = formatted
        ? await postTelegram("sendMessage", { text: formatted, parse_mode: "HTML" }, threadId)
        : null;
      if (!sent) sent = await sendMessage(text, { thread: threadId });
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    let edited = formatted
      ? await postTelegram("editMessageText", { message_id: state.messageId, text: formatted, parse_mode: "HTML" })
      : null;
    if (!edited) await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  // The mention gate needs our own username/id; without it every group
  // message would be dropped as "not mentioned", so block until getMe works.
  while (_polling && !_botUsername) {
    if (await fetchBotIdentity()) break;
    await sleep(5000);
  }
  while (_polling) {
    try {
      const res = await tgFetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
            message_thread_id: callback.message.message_thread_id,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        const prep = prepareIncomingText(msg);
        if (!prep.accept) continue; // group chatter not addressed to us
        await onMessage({ ...msg, text: prep.text });
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

const BOT_COMMANDS = [
  { command: "help",       description: "Show commands" },
  { command: "status",     description: "Wallet + positions snapshot" },
  { command: "wallet",     description: "Wallet, deploy amount, HiveMind status" },
  { command: "positions",  description: "List open positions" },
  { command: "pool",       description: "Detailed info for one open position" },
  { command: "close",      description: "Close one position by index" },
  { command: "closeall",   description: "Close all open positions" },
  { command: "set",        description: "Set note/instruction on position" },
  { command: "config",     description: "Show important runtime config" },
  { command: "settings",   description: "Button menu for common config" },
  { command: "setcfg",     description: "Update persisted config key" },
  { command: "screen",     description: "Refresh deterministic candidate list" },
  { command: "candidates", description: "Show latest cached candidates" },
  { command: "deploy",     description: "Deploy candidate by cached index" },
  { command: "briefing",   description: "Morning briefing" },
  { command: "pnl",        description: "Full PnL report (on-chain + all costs)" },
  { command: "report",     description: "Laporan keuangan periode (week/month)" },
  { command: "hive",       description: "HiveMind sync status" },
  { command: "pause",      description: "Stop cron cycles" },
  { command: "resume",     description: "Start cron cycles again" },
  { command: "stop",       description: "Shut down agent" },
];

async function registerCommands() {
  if (!BASE) return;
  try {
    await tgFetch(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    log("telegram", "Bot commands registered");
  } catch (e) {
    log("telegram_warn", `Failed to register bot commands: ${e.message}`);
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  loadChatId();
  if (!chatId) {
    log("telegram_warn", "TELEGRAM_CHAT_ID not set in .env or user-config.telegramChatId — outbound notifications and inbound control disabled until configured.");
  }
  _polling = true;
  poll(onMessage); // fire-and-forget
  registerCommands();
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
  if (hasActiveLiveMessage()) return;
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  await sendHTML(
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    coverageStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`,
    { thread: TOPICS.activity }
  );
}

export async function notifyClose({ pair, pnlUsd, pnlPct }) {
  if (hasActiveLiveMessage()) return;
  const sign = pnlUsd >= 0 ? "+" : "";
  await sendHTML(
    `🔒 <b>Closed</b> ${pair}\n` +
    `PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`,
    { thread: TOPICS.activity }
  );
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`,
    { thread: TOPICS.activity }
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${pair}\n` +
    `Been OOR for ${minutesOOR} minutes`,
    { thread: TOPICS.activity }
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
