// chatformat.js - /help/formatting (1.99aem): the member guide to formatting messages in PATV Chat, the native chat a
// pad's Live tab shows (the S1 widget). The formatting itself is the chat platform's (patv-platform chat-core's
// markdown-lite, ADR 0004 "Formatting as built"): Discord's marks, a block quote with "> ", and the composer's Aa
// button that writes them. This page lists every form with an example, what it looks like, and what a BRIDGED chat
// will show for it once a pad is bridged to another network (not yet: the bridged chats come later, Camfrog first,
// other networks after, all with the same plain text), so a member knows what the people on the other side will see.
//
// The page is rendered FROM this table (views/chatFormatting.ejs), so a form can't be described without its row. Each
// row: id (the anchor #fmt-<id>, strings chatfmt.f.<id> name and chatfmt.n.<id> note), what to type (`{w}` is the
// row's sample word: `w` when it must not be translated, else chatfmt.w.<id>), how the page draws the result (`view`),
// and what a bridge will show (chatfmt.bridge.<bridge>). Linked from the composer's formatting bar (its ? button) and
// from /help.
//
// The W-format review (2026-10-25): no time form (the chat dropped its <t:...> syntax for the widget's size budget),
// no link previews promised (PATV Chat shows none yet), the bridged column worded for later, the spoiler preview a
// disclosure (details/summary: a screen reader hears the hint, then the words once it is opened; a tap opens it on
// iOS too), and the backslash's use for maths and names with underscores.
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
  { id: "escape", type: ["\\*{w}\\*"], view: "literal", bridge: "literal" },
]);

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
        typed,
        word,
      });
    } catch (e) {
      console.error("[chatformat]", e);
      res.status(500).send("Something went wrong.");
    }
  });
}

module.exports = { register, FORMS, PATH, typed, word };
