// Telegram group mention gate.
//
// Before this gate every text message from an allowed user in the group
// reached telegramHandler → agentLoop, so ordinary chatter between members
// burned LLM turns. prepareIncomingText decides whether a message is
// addressed to the bot (mention / reply / slash command) and strips the
// bot's own @mention so the goal reads naturally. Pure function — no
// network, no TOKEN needed.

import "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { prepareIncomingText } = await import("../telegram.js");

const BOT = { botUsername: "MeridianBot", botId: 777, requireMention: true };
const group = (text, extra = {}) => ({ chat: { type: "supergroup", id: -100 }, from: { id: 1 }, text, ...extra });
const priv = (text, extra = {}) => ({ chat: { type: "private", id: 1 }, from: { id: 1 }, text, ...extra });

test("group: plain chatter without mention is dropped", () => {
  const r = prepareIncomingText(group("gimana posisi hari ini?"), BOT);
  assert.equal(r.accept, false);
  assert.equal(r.reason, "not_mentioned");
});

test("group: @mention entity is accepted and stripped", () => {
  const text = "@MeridianBot gimana posisi hari ini?";
  const r = prepareIncomingText(group(text, { entities: [{ type: "mention", offset: 0, length: 12 }] }), BOT);
  assert.equal(r.accept, true);
  assert.equal(r.text, "gimana posisi hari ini?");
});

test("group: mention in the middle, case-insensitive, no entities", () => {
  const r = prepareIncomingText(group("hei @meridianbot cek wallet dong"), BOT);
  assert.equal(r.accept, true);
  assert.equal(r.text, "hei cek wallet dong");
});

test("group: mention of another bot is not ours", () => {
  const text = "@OtherBot cek wallet";
  const r = prepareIncomingText(group(text, { entities: [{ type: "mention", offset: 0, length: 9 }] }), BOT);
  assert.equal(r.accept, false);
});

test("group: @MeridianBotX is a different username", () => {
  const r = prepareIncomingText(group("@MeridianBotX halo"), BOT);
  assert.equal(r.accept, false);
});

test("group: reply to one of the bot's messages counts as addressing it", () => {
  const r = prepareIncomingText(group("kenapa ditutup?", { reply_to_message: { from: { id: 777, is_bot: true } } }), BOT);
  assert.equal(r.accept, true);
  assert.equal(r.text, "kenapa ditutup?");
});

test("group: reply to a human is still chatter", () => {
  const r = prepareIncomingText(group("kenapa ditutup?", { reply_to_message: { from: { id: 42 } } }), BOT);
  assert.equal(r.accept, false);
});

test("group: text_mention entity pointing at the bot id is accepted", () => {
  const text = "Meridian tolong /status";
  // text_mention is what Telegram sends when the mentioned account has no username
  const r = prepareIncomingText(group(text, { entities: [{ type: "text_mention", offset: 0, length: 8, user: { id: 777 } }] }), BOT);
  assert.equal(r.accept, true);
  assert.equal(r.text, "tolong /status");
});

test("group: slash commands always pass, with our @suffix stripped", () => {
  assert.deepEqual(prepareIncomingText(group("/status"), BOT), { accept: true, text: "/status" });
  assert.deepEqual(prepareIncomingText(group("/status@MeridianBot"), BOT), { accept: true, text: "/status" });
  assert.deepEqual(prepareIncomingText(group("/close@meridianbot 2"), BOT), { accept: true, text: "/close 2" });
  assert.deepEqual(prepareIncomingText(group("/set 1 close when pnl > 5%"), BOT), { accept: true, text: "/set 1 close when pnl > 5%" });
});

test("group: slash command addressed to another bot is dropped", () => {
  const r = prepareIncomingText(group("/status@OtherBot"), BOT);
  assert.equal(r.accept, false);
  assert.equal(r.reason, "command_for_other_bot");
});

test("private chat: everything passes unchanged", () => {
  assert.equal(prepareIncomingText(priv("gimana posisi?"), BOT).accept, true);
  assert.equal(prepareIncomingText(priv("gimana posisi?"), BOT).text, "gimana posisi?");
  assert.deepEqual(prepareIncomingText(priv("/status@MeridianBot"), BOT), { accept: true, text: "/status" });
});

test("gate off: group chatter passes like before", () => {
  const r = prepareIncomingText(group("gimana posisi?"), { ...BOT, requireMention: false });
  assert.equal(r.accept, true);
  assert.equal(r.text, "gimana posisi?");
});

test("unknown identity: group text without a mention is dropped, commands still pass", () => {
  const noId = { botUsername: null, botId: null, requireMention: true };
  assert.equal(prepareIncomingText(group("halo"), noId).accept, false);
  assert.equal(prepareIncomingText(group("/status"), noId).accept, true);
});
