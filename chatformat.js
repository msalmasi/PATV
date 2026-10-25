// chatformat.js - /help/formatting (1.99aem): the member guide to formatting messages in PATV Chat, the native chat a
// pad's Live tab shows (the S1 widget). The formatting itself is the chat platform's (patv-platform chat-core's
// markdown-lite, ADR 0004 "Formatting as built"): Discord's marks, a block quote with "> ", and the composer's Aa
// button that writes them. This page lists every form with an example, what it looks like, and what a BRIDGED chat
// shows for it (Camfrog today; other networks later get the same plain text), so a member knows what the people on
// the other side will see.
//
// The page is rendered FROM this table (views/chatFormatting.ejs), so a form can't be described without its row. Each
// row: id (the anchor #fmt-<id>, strings chatfmt.f.<id> name and chatfmt.n.<id> note), what to type (`{w}` is the
// row's sample word: `w` when it must not be translated, else chatfmt.w.<id>), how the page draws the result (`view`),
// and what a bridge shows (chatfmt.bridge.<bridge>). Linked from the composer's formatting bar (its ? button) and from
// /help.
"use strict";

const PATH = "/help/formatting";

const FORMS = Object.freeze([
  { id: "bold", type: ["**{w}**"], view: "b", bridge: "plain" },
  { id: "italic", type: ["*{w}*", "_{w}_"], view: "i", bridge: "plain" },
  { id: "bolditalic", type: ["***{w}***"], view: "bi", bridge: "plain" },
  { id: "underline", type: ["__{w}__"], view: "u", bridge: "plain" },
  { id: "strike", type: ["~~{w}~~"], view: "s", bridge: "plain" },
  { id: "spoiler", type: ["||{w}||"], view: "spoiler", bridge: "spoiler" },
  { id: "code", type: ["`{w}`"], view: "code", bridge: "plain", w: "!balance" },
  { id: "codeblock", type: ["```js\n{w}\n```"], view: "pre", bridge: "code", w: "console.log(\"gg\");" },
  { id: "quote", type: ["> {w}"], view: "quote", bridge: "quote" },
  { id: "quoteall", type: [">>> {w}"], view: "quote", bridge: "quote" },
  { id: "link", type: ["{w}"], view: "link", bridge: "link", w: "https://publicaccess.tv" },
  { id: "nopreview", type: ["<{w}>"], view: "link", bridge: "link", w: "https://publicaccess.tv" },
  { id: "mention", type: ["@{w}"], view: "mention", bridge: "mention", w: "PepeFrog" },
  { id: "everyone", type: ["@here", "@everyone"], view: "mention", bridge: "mention", w: "here" },
  { id: "emoji", type: [":frog:"], view: "emoji", bridge: "emoji", w: "🐸" },
  { id: "time", type: ["<t:{w}:f>"], view: "time", bridge: "time", w: "1767225600" },
  { id: "escape", type: ["\\*{w}\\*"], view: "literal", bridge: "literal" },
]);

/** The time styles of <t:SECONDS:STYLE> (Discord's letters; strings chatfmt.time.<key>), each drawn in UTC on the page. */
const TIME_STYLES = Object.freeze([
  { s: "t", key: "short_time", opts: { timeStyle: "short" } },
  { s: "T", key: "long_time", opts: { timeStyle: "medium" } },
  { s: "d", key: "short_date", opts: { dateStyle: "short" } },
  { s: "D", key: "long_date", opts: { dateStyle: "long" } },
  { s: "f", key: "date_time", opts: { dateStyle: "long", timeStyle: "short" } },
  { s: "F", key: "full", opts: { dateStyle: "full", timeStyle: "short" } },
  { s: "R", key: "relative", opts: null },
]);

/** The example time: 1767225600 = 2026-01-01T00:00:00Z. */
const SAMPLE_TIME = 1767225600;

/** The sample's words, as typed: the row's own (`w`) or the translated one. */
function word(form, t) {
  return form.w != null ? form.w : t("chatfmt.w." + form.id);
}

/** What to type for a form, with its sample word in it (plain text; the view escapes it). */
function typed(form, t) {
  const w = word(form, t);
  return form.type.map((x) => x.split("{w}").join(w));
}

function register(app, { addUser }) {
  app.get(PATH, addUser, (req, res) => {
    try {
      res.set("Cache-Control", "private, max-age=0, must-revalidate");
      res.render("chatFormatting", {
        user: req.user ? req.user.username : null,
        FORMS,
        TIME_STYLES,
        SAMPLE_TIME,
        typed,
        word,
      });
    } catch (e) {
      console.error("[chatformat]", e);
      res.status(500).send("Something went wrong.");
    }
  });
}

module.exports = { register, FORMS, TIME_STYLES, SAMPLE_TIME, PATH, typed, word };
