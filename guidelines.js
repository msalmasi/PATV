// guidelines.js — Padiquette (1.99dc): PATV's site-wide guidelines, the page at /guidelines and the
// machine-readable rule list Pepe's feed automod judges by (feedautomod.js) when a pad has no rules of its own.
//
// The page (views/guidelines.ejs) is rendered FROM this file, so the words people read and the rules the
// automod applies can't drift apart. Spirit: Reddiquette-style "be decent", with a WIDE latitude for free
// speech and unfiltered language. Only the hard limits (RULES) are enforced; everything in LATITUDE is
// explicitly fine unless a pad's own rules say otherwise.
//
// RULES[].severity:  "severe"  - illegal / real-world harm; the automod's default is flag + hide (CSAM also
//                                runs the existing urgent CSAM path, whatever a pad's settings say)
//                    "serious" - real harm to people on the site; default flag
//                    "minor"   - housekeeping (spam, missing NSFW tag); default flag
// RULES[].report: the feed report reason (feedstore.REASONS) an automod flag files under, so the flag lands in
// the right queue (child-safety / NCII / illegal content go to the site admins only, like a human report).
"use strict";

const NAME = "Padiquette";
const UPDATED = "2026-10-07";
const PATH = "/guidelines";

const INTRO = "PATV is a bunch of pads full of people who like to talk, joke, argue and hang out - online and in the Camfrog rooms. "
  + "Padiquette is how we keep that fun without turning it into a hall monitor's dream. It's short on purpose: "
  + "say what you think, swear if you want, and don't make the place worse for other people.";

/** What we'd like to see (encouraged, not enforced - except where it overlaps a hard limit). */
const GOOD = Object.freeze([
  { title: "Be a decent human", text: "There's a person on the other end of every post, cam and mic. Roast the take, not the person's kid." },
  { title: "Don't be a dick for sport", text: "Banter is great. Picking on someone who clearly isn't playing along, over and over, isn't banter." },
  { title: "Respect the pad's own rules", text: "Every pad can set its own rules. If you're posting in someone's pad, read them - they win over this page inside that pad." },
  { title: "Tag it NSFW", text: "Adult stuff is allowed. Just tick the 🔞 NSFW box so people can choose when they see it." },
  { title: "Credit creators", text: "Posting someone's clip, art, music or meme? Say where it came from. Don't pass off other people's work as yours." },
  { title: "Report, don't retaliate", text: "If something crosses a line, hit Report. Starting a war in the comments just makes two problems." },
  { title: "No brigading", text: "Don't round up a crowd to pile onto a person, a post or another pad." },
  { title: "No spam, no scams", text: "Post things people might actually want to see. No ad floods, fake giveaways, PAT schemes or engagement farming." },
]);

/** What is explicitly fine here (the automod is told so in so many words). */
const LATITUDE = Object.freeze([
  { title: "Swearing and unfiltered language", text: "Curse all you like. Nobody's washing your mouth out with soap." },
  { title: "Dark and crude humour", text: "Edgy jokes, gallows humour and bad taste are part of the culture here." },
  { title: "Roasting and trash talk", text: "Roasts, insults and banter between people who are in on it are fine - that's half of Camfrog." },
  { title: "Hot takes and strong opinions", text: "Politics, religion, sports, music, that one movie: argue it out. Disagreeing loudly is not harassment." },
  { title: "Adult topics", text: "Sex, drugs, relationships, nightlife, frank talk - fine, as long as it's legal and anything explicit is tagged NSFW." },
]);

/** The hard limits: the only things removed site-wide. ids are stable (the automod cites them). */
const RULES = Object.freeze([
  { id: "csam", title: "No sexual content involving minors", desc: "Zero tolerance. Any sexual or sexualised content involving anyone under 18 - real, drawn or generated. It's removed, the account is banned and we report it to the authorities.", severity: "severe", report: "csam" },
  { id: "illegal", title: "Nothing illegal", desc: "No content that's illegal to post or that sells or arranges something illegal (drugs for sale, weapons deals, stolen data and the like).", severity: "severe", report: "illegal" },
  { id: "doxxing", title: "No doxxing or private info", desc: "Never post someone's real name, address, phone, workplace, school, ID, private photos or accounts unless they made it public themselves. Not even as a joke.", severity: "severe", report: "personal" },
  { id: "threats", title: "No credible threats or incitement", desc: "No threatening to hurt someone, and no urging others to. Obvious jokes and hyperbole (\"I'll kill you if you skip this song\") are not threats.", severity: "severe", report: "violence" },
  { id: "ncii", title: "No non-consensual intimate imagery", desc: "No nude or sexual pictures or video of someone who didn't agree to them being shared - including deepfakes.", severity: "severe", report: "ncii" },
  { id: "harassment", title: "No targeted harassment campaigns", desc: "No hounding a person across posts and pads, organising pile-ons, encouraging others to go after someone, or going after people for who they are (race, religion, sexuality, gender, disability). One heated argument isn't a campaign, and an offensive joke or opinion isn't harassment.", severity: "serious", report: "harassment" },
  { id: "impersonation", title: "No deceptive impersonation", desc: "Don't pretend to be another person, a pad or PATV staff to fool people. Obvious parody is fine.", severity: "serious", report: "impersonation" },
  { id: "malware", title: "No malware or phishing", desc: "No links or files meant to infect devices, steal logins or grab PAT, accounts or payment details.", severity: "serious", report: "spam" },
  { id: "fraud", title: "No fraud or scams", desc: "No fake giveaways, PAT or money schemes, or tricking people into paying for something.", severity: "serious", report: "spam" },
  { id: "spam", title: "No spam", desc: "No ad floods, repeated junk or fake engagement.", severity: "minor", report: "spam" },
  { id: "nsfw", title: "Tag adult content NSFW", desc: "Explicit sexual content or gore must be marked 🔞 NSFW. Missing tag = it gets tagged or hidden, not a ban.", severity: "minor", report: "nsfw" },
]);
const RULE_IDS = new Set(RULES.map((r) => r.id));
const SEVERE = Object.freeze(RULES.filter((r) => r.severity === "severe").map((r) => r.id));
/** The hard limits that hold in EVERY pad, even one with its own rules (pad rules add to these, never remove them). */
const ALWAYS = Object.freeze(RULES.map((r) => r.id));
const rule = (id) => RULES.find((r) => r.id === id) || null;

/** 1.99en: THE AI generation content policy (the one written copy on the site): Padiquette's "AI pictures and video"
 *  section (#ai), the feed composer's Generate help (feedweb.js -> cp.aigen.policy) and aigen.js's explicit-prompt
 *  check all use it. Pepe enforces the same rules (camfrog-bot pepe_aigen.py AIGEN_POLICY). */
const AI_POLICY = Object.freeze({
  short: "No explicit nudity — suggestive is fine. Nothing sexual with minors or real people.",
  intro: "PATV is adults-only (18+). Pictures and videos made with Pepe (!imagine, !video, the feed's ✨ Generate) follow these rules - the same in chat and on the site:",
  allowed: Object.freeze([
    "Photorealistic pictures, including realistic people.",
    "Sexually suggestive and R-rated content: lingerie, swimwear, innuendo, implied sexuality, R-level violence. Suggestive results are marked 🔞 NSFW automatically, so they're blurred for anyone signed out or not opted in.",
  ]),
  never: Object.freeze([
    "Explicit nudity, for anyone - fictional or real: exposed genitals, exposed female nipples, sex acts.",
    "Anything sexual or suggestive involving minors, or anyone who looks under 18. Zero tolerance.",
    "Nude, sexual or sexualised pictures of a real, identifiable person - a named or public person, someone in the room, or the person in a cam / reference photo.",
  ]),
  enforcement: "Pepe checks the prompt before anything is charged and the result before it's posted. A refused prompt costs nothing; a refused result is refunded.",
});

/** One-paragraph statement of the free-speech stance (the automod prompt quotes it verbatim). */
const SPEECH = "PATV gives WIDE latitude to free speech and unfiltered language. Profanity, crude or dark humour, edgy jokes, "
  + "roasting, insults and trash talk between people who are in on it, hot takes, political and religious opinions, and adult "
  + "topics (tagged NSFW when explicit) are NOT violations. Only act when content clearly breaks one of the listed rules.";

/** The rule list as plain text for a prompt: "[id] title - desc" per line. */
function promptList(list = RULES) {
  return list.map((r) => `[${r.id}] ${r.title} - ${r.desc}`).join("\n");
}

function register(app, { addUser } = {}) {
  const mw = addUser ? [addUser] : [];
  app.get(PATH, ...mw, (req, res) => {
    res.locals.og = Object.assign({}, res.locals.og || {}, { title: NAME + " — how we get along on PATV", description: "Be decent, swear if you like, don't make it worse for other people. PATV's site-wide guidelines." });
    res.render("guidelines", { user: req.user ? req.user.username : null, G: module.exports });
  });
  app.get("/padiquette", (req, res) => res.redirect(301, PATH));
  app.get("/rules", (req, res) => res.redirect(301, PATH));
}

module.exports = { NAME, UPDATED, PATH, INTRO, GOOD, LATITUDE, RULES, AI_POLICY, RULE_IDS, SEVERE, ALWAYS, SPEECH, rule, promptList, register };
