// stageembed.js — YouTube / Twitch links people can put on a room's stage instead of streaming.
//
// We never store or render a URL someone typed. A link is parsed into {p, t, id} (platform, type,
// id), every part checked against a strict pattern, and the player URL is built from those parts
// only - always one of the official embed players:
//   youtube video / live video   https://www.youtube-nocookie.com/embed/<11-char id>
//   youtube channel's live now   https://www.youtube-nocookie.com/embed/live_stream?channel=<UC id>
//   twitch channel (live)        https://player.twitch.tv/?channel=<login>&parent=<our host>
//   twitch VOD                   https://player.twitch.tv/?video=v<digits>&parent=<our host>
// Anything else (other hosts, playlists, @handles we can't resolve, clips, junk) is refused.
"use strict";

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const TW_LOGIN = /^[A-Za-z0-9_]{3,25}$/;
const TW_VOD = /^[0-9]{5,12}$/;
const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
                          "www.youtube-nocookie.com", "youtube-nocookie.com"]);
const TW_HOSTS = new Set(["twitch.tv", "www.twitch.tv", "m.twitch.tv", "go.twitch.tv", "player.twitch.tv"]);
// Twitch paths that are pages, not channels
const TW_RESERVED = new Set(["directory", "videos", "settings", "subscriptions", "inventory", "wallet", "drops",
                             "search", "downloads", "jobs", "p", "turbo", "friends", "messages", "following", "login", "signup"]);

class EmbedError extends Error {}
const bad = (m) => { throw new EmbedError(m || "That isn't a YouTube or Twitch link we can play."); };

/** Parse a pasted link into {p, t, id}. Throws EmbedError with a friendly message. */
function parse(input) {
  let s = String(input == null ? "" : input).trim();
  if (!s) bad("Paste a YouTube or Twitch link.");
  if (s.length > 300) bad("That link is too long.");
  if (/[\s<>"'`\\]/.test(s)) bad();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch (e) { bad(); }
  if (u.protocol !== "https:" && u.protocol !== "http:") bad();
  if (u.username || u.password || (u.port && u.port !== "443" && u.port !== "80")) bad();
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  if (YT_HOSTS.has(host)) {
    let id = null;
    if (host === "youtu.be") id = parts[0];
    else if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (["live", "embed", "shorts", "v"].includes(parts[0]) && parts[1] && parts[1] !== "live_stream") id = parts[1];
    else if (parts[0] === "embed" && parts[1] === "live_stream") {
      const ch = u.searchParams.get("channel");
      if (ch && YT_CHANNEL.test(ch)) return { p: "youtube", t: "channel", id: ch };
      bad();
    } else if (parts[0] === "channel" && parts[1] && YT_CHANNEL.test(parts[1])) {
      return { p: "youtube", t: "channel", id: parts[1] };      // /channel/UC.../live or the channel itself
    } else if (parts[0] && parts[0].startsWith("@")) {
      bad("Use the video's link (or youtube.com/channel/UC…/live) - we can't look up @handles.");
    }
    if (id && YT_ID.test(id)) return { p: "youtube", t: parts[0] === "live" ? "live" : "video", id };
    bad();
  }

  if (TW_HOSTS.has(host)) {
    if (host === "player.twitch.tv") {
      const ch = u.searchParams.get("channel"), v = String(u.searchParams.get("video") || "").replace(/^v/, "");
      if (ch && TW_LOGIN.test(ch)) return { p: "twitch", t: "channel", id: ch.toLowerCase() };
      if (v && TW_VOD.test(v)) return { p: "twitch", t: "vod", id: v };
      bad();
    }
    if (parts[0] === "videos" && parts[1] && TW_VOD.test(parts[1])) return { p: "twitch", t: "vod", id: parts[1] };
    if (parts.length >= 1 && TW_LOGIN.test(parts[0]) && !TW_RESERVED.has(parts[0].toLowerCase())) {
      if (parts[1] === "clip" || parts[1] === "clips") bad("Twitch clips can't go on the stage - use the channel or a VOD link.");
      if (parts[1] === "video" || parts[1] === "videos") {
        if (parts[2] && TW_VOD.test(parts[2])) return { p: "twitch", t: "vod", id: parts[2] };
        bad();
      }
      return { p: "twitch", t: "channel", id: parts[0].toLowerCase() };
    }
    bad();
  }
  bad();
}

/** Re-validate a stored {p, t, id} (from the DB). Returns a clean copy or null. */
function clean(e) {
  if (!e || typeof e !== "object") return null;
  const p = String(e.p || ""), t = String(e.t || ""), id = String(e.id || "");
  if (p === "youtube" && (t === "video" || t === "live") && YT_ID.test(id)) return { p, t, id };
  if (p === "youtube" && t === "channel" && YT_CHANNEL.test(id)) return { p, t, id };
  if (p === "twitch" && t === "channel" && TW_LOGIN.test(id)) return { p, t, id: id.toLowerCase() };
  if (p === "twitch" && t === "vod" && TW_VOD.test(id)) return { p, t, id };
  return null;
}

/** The official player URL for a clean embed. `parent` = the page's hostname (Twitch requires it). */
function playerUrl(e, parent) {
  const c = clean(e);
  if (!c) return null;
  const host = /^[a-z0-9.-]{1,253}$/i.test(String(parent || "")) ? String(parent).toLowerCase() : "publicaccess.tv";
  if (c.p === "youtube") {
    const q = "autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1";
    return c.t === "channel" ? `https://www.youtube-nocookie.com/embed/live_stream?channel=${c.id}&${q}`
                             : `https://www.youtube-nocookie.com/embed/${c.id}?${q}`;
  }
  return c.t === "vod" ? `https://player.twitch.tv/?video=v${c.id}&parent=${host}&autoplay=true&muted=true`
                       : `https://player.twitch.tv/?channel=${c.id}&parent=${host}&autoplay=true&muted=true`;
}

/** A short human label: "YouTube video", "Twitch: somechannel", ... */
function label(e) {
  const c = clean(e);
  if (!c) return "";
  if (c.p === "youtube") return c.t === "channel" ? "YouTube live channel" : c.t === "live" ? "YouTube live" : "YouTube video";
  return c.t === "vod" ? "Twitch VOD" : "Twitch: " + c.id;
}

/** The signed-in user's own Twitch channel link, for the "Use my Twitch channel" suggestion on the
 *  link field - or null. Only a connected account (twitchId) counts. Twitch OAuth stores display_name
 *  (twitchDisplayname), which is the login with different capitals for ASCII names; a localized display
 *  name (e.g. CJK) isn't a login, so there's no suggestion for it. The result is always something
 *  parse() accepts as a channel, and it still goes through parse() when they submit. */
function twitchChannelUrl(user) {
  if (!user || !user.twitchId) return null;
  const login = String(user.twitchDisplayname || "").trim();
  if (!TW_LOGIN.test(login) || TW_RESERVED.has(login.toLowerCase())) return null;
  return "https://twitch.tv/" + login.toLowerCase();
}

module.exports = { parse, clean, playerUrl, label, twitchChannelUrl, EmbedError };
