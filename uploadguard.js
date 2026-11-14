// uploadguard.js - 1.99anw: the site's two multer routes - a member's profile photo (POST /api/u/:username/update/avatar,
// user.controller updateAvatar) and the admin badge form (POST /api/badges/add, index.js) - with limits, a pictures-only filter
// and an answer for every parser error.
//
// Why (review 1.99anw): multer 1.4.5-lts.1 had no limits here and left busboy without an 'error' listener once it had finished,
// so ONE request - a file part with no closing boundary ("Unexpected end of form"), from any signed-in member - was an uncaught
// exception that ended the site's process. multer 2.5.0 keeps a listener for busboy's whole life; this adds the caps it was never
// given (file size, files, fields, parts), refuses a part that isn't a picture before anything is written to disk, and turns every
// MulterError / busboy error into a 400 / 413 JSON answer. safe() makes a handler's rejection a 500, never an unhandled rejection.
// The multer instances themselves stay where multer always was (index.js, user.controller.js - test/botkeys-callsites.test.js);
// they are built from the options here.
"use strict";

const MB = 1024 * 1024;

// The profile photo: one file field, "avatar" (public/js/upload-avatar.js and views/editProfile.ejs send nothing else), a raster
// picture sharp decodes, at most 8 MB (nginx in front takes 1 MB a request today - botupload.js - so this never binds first).
// Review 1.99anw: + the non-standard names some clients give a JPEG or an animated PNG (image/jpg, image/apng) - sharp decoded them
// before. What the browser says only sorts out what to write to disk: updateAvatar reads the real format from the file's header
// (imagebudget.check), so an SVG sent as image/png is refused there.
const AVATAR_TYPES = Object.freeze(["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/x-png", "image/apng", "image/webp", "image/gif", "image/avif", "image/tiff"]);
const AVATAR = Object.freeze({
  limits: Object.freeze({ fileSize: 8 * MB, files: 1, fields: 4, fieldSize: 4096, fieldNameSize: 100, parts: 5, headerPairs: 20 }),
  maxBody: 8 * MB + 64 * 1024,
});
// The badge form (views/admin/cosmetics.ejs: name, points, icon, requirement, description) - text only.
const BADGE_FORM = Object.freeze({
  limits: Object.freeze({ files: 0, fields: 10, fieldSize: 16 * 1024, fieldNameSize: 100, parts: 10, headerPairs: 20 }),
  maxBody: 256 * 1024,
});

const NOT_A_PICTURE = "NOT_A_PICTURE";
/** multer's fileFilter for the profile photo: the "avatar" field, a picture type (what the browser says - sharp has the last word). */
function avatarFilter(req, file, cb) {
  const type = String((file && file.mimetype) || "").toLowerCase();
  if (file && file.fieldname === "avatar" && AVATAR_TYPES.includes(type)) return cb(null, true);
  const err = new Error("not a picture");
  err.code = NOT_A_PICTURE;
  return cb(err);
}

/** The multer instances (index.js / user.controller.js pass in the multer module they load). */
function avatarUpload(multer) { return multer({ dest: "uploads/", limits: AVATAR.limits, fileFilter: avatarFilter }); }
function badgeFormUpload(multer) { return multer({ dest: "uploads/", limits: BADGE_FORM.limits }); }

// MulterError codes that mean "over a cap" (413); every other MulterError is a 400 (an unexpected file, a missing / bad field name)
const TOO_LARGE = new Set(["LIMIT_FILE_SIZE", "LIMIT_FILE_COUNT", "LIMIT_PART_COUNT", "LIMIT_FIELD_KEY", "LIMIT_FIELD_VALUE",
  "LIMIT_FIELD_COUNT", "LIMIT_FIELD_NESTING", "LIMIT_FIELD_ARRAY_INDEX"]);

/** [status, code, message] for an error multer handed to next(): 413 over a cap, 400 not a picture / a malformed or cut-off body
 *  (busboy: "Malformed part header", "Unexpected end of form", "Multipart: Boundary not found", a closed request), 500 only when
 *  the disk failed (a system error: ENOSPC, EACCES, ...). */
function classify(err) {
  const code = err && typeof err.code === "string" ? err.code : "";
  if (err && err.name === "MulterError") {
    if (TOO_LARGE.has(code)) return [413, code, "That upload is too big."];
    return [400, code || "BAD_UPLOAD", "That upload wasn't a form this page sends."];
  }
  if (code === NOT_A_PICTURE) return [400, code, "That isn't a picture - use a JPEG, PNG, WebP, GIF or AVIF."];
  if (code === "TOO_LARGE") return [413, code, "That upload is too big."];
  if (err && (typeof err.errno === "number" || typeof err.syscall === "string") && /^E[A-Z]+$/.test(code)) return [500, "STORAGE", "The upload couldn't be saved - try again in a minute."];
  return [400, "BAD_UPLOAD", "That upload was malformed or cut off."];
}

/** A refused body's unread rest is read and thrown away (at most `cap` bytes, for at most 5 s - then the connection is cut), so
 *  the caller reads the answer instead of a reset connection (plexhook.js linger). */
function linger(req, cap) {
  if (req.complete || req.destroyed) return;
  let drained = 0;
  const cut = () => { try { req.destroy(); } catch (_) { /* gone already */ } };
  const t = setTimeout(cut, 5000);
  if (t.unref) t.unref();
  const stop = () => clearTimeout(t);
  req.on("data", (chunk) => { drained += chunk.length; if (drained > cap) { stop(); cut(); } });
  req.on("end", stop); req.on("close", stop); req.on("error", stop);
  req.resume();
}

function refuse(req, res, [status, code, message], what) {
  if (status >= 500) console.error(`[uploads] ${what}: the upload couldn't be stored (${code})`);
  if (res.headersSent) return;
  try { res.status(status).set("Cache-Control", "no-store").json({ success: false, error: code, message }); } catch (_) { /* gone */ }
}

/** A multer middleware behind the caps: a declared Content-Length over opts.maxBody is refused (413) before anything is parsed, a
 *  body that keeps coming past twice that is cut, and whatever multer hands to next(err) is answered here (400 / 413 / 500 JSON)
 *  instead of going on to Express's HTML error page. */
function guard(mw, opts = {}, what = "upload") {
  const maxBody = Number(opts.maxBody) > 0 ? Number(opts.maxBody) : 1 * MB;
  return function uploadGuard(req, res, next) {
    if (!/^multipart\//i.test(String(req.headers["content-type"] || "").trim())) return mw(req, res, next);   // multer's own skip
    const len = Number(req.headers["content-length"]);
    if (req.headers["content-length"] != null && Number.isFinite(len) && len > maxBody) {
      linger(req, 2 * maxBody);
      return refuse(req, res, classify({ code: "TOO_LARGE" }), what);
    }
    let seen = 0, called = false;
    const count = (chunk) => { seen += chunk.length; if (seen > 2 * maxBody) { try { req.destroy(); } catch (_) { /* gone */ } } };
    req.on("data", count);
    mw(req, res, (err) => {
      if (called) return;                      // (never twice)
      called = true;
      req.removeListener("data", count);
      if (!err) return next();
      return refuse(req, res, classify(err), what);
    });
  };
}

/** An async route handler whose rejection is answered (500 JSON) and logged, never left to the process (express 4 doesn't catch it,
 *  and an unhandled rejection ends a Node 22 process). */
function safe(handler, what = "upload") {
  return function safeHandler(req, res, next) {
    const failed = (e) => {
      console.error(`[uploads] ${what} failed:`, (e && e.message) || e);
      try { if (!res.headersSent) res.status(500).json({ success: false, message: "That didn't work - try again in a minute." }); } catch (_) { /* gone */ }
    };
    let p;
    try { p = handler(req, res, next); } catch (e) { return failed(e); }
    if (p && typeof p.then === "function") p.then(null, failed);
  };
}

module.exports = { AVATAR, BADGE_FORM, AVATAR_TYPES, NOT_A_PICTURE, avatarFilter, avatarUpload, badgeFormUpload, classify, guard, safe, linger };
