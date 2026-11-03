// mailer.js - 1.99aim: how an account email (the sign-up / changed-address verification link) is sent. Resend first when
// RESEND_API_KEY is set, then SendGrid when SENDGRID_API_KEY is set - the order index.js's password-reset mail and shop.js
// already use. On 2026-11-03 the SendGrid key answered 401 Unauthorized, and the verification email (the one path that
// called SendGrid directly) silently never arrived while Resend was configured and working.
// send() throws when no provider accepted the email; the message names the providers and their status, never a key or
// the email's text.
"use strict";

const FROM = "no-reply@publicaccess.tv";
let resend = null;
let sendgrid = null;

function resendClient() {
  if (!resend) {
    const { Resend } = require("resend");
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

function sendgridClient() {
  if (!sendgrid) {
    sendgrid = require("@sendgrid/mail");
    sendgrid.setApiKey(process.env.SENDGRID_API_KEY);
  }
  return sendgrid;
}

/** {to, subject, text, html[, from]} -> "resend" | "sendgrid" (the provider that accepted it); throws if none did. */
async function send({ to, subject, text, html, from = FROM }) {
  const failed = [];
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await resendClient().emails.send({ from, to, subject, text, html });
      if (r && r.error) throw new Error(r.error.message || "refused the email");
      return "resend";
    } catch (e) {
      failed.push(`resend: ${e && e.message ? e.message : e}`);
    }
  }
  if (process.env.SENDGRID_API_KEY) {
    try {
      await sendgridClient().send({ from, to, subject, text, html });
      return "sendgrid";
    } catch (e) {
      failed.push(`sendgrid: ${e && e.code ? e.code + " " : ""}${e && e.message ? e.message : e}`);
    }
  }
  throw new Error(failed.length ? failed.join("; ") : "no mailer configured");
}

module.exports = {
  send,
  FROM,
  // tests: stand-ins for the two providers (null = the real one again)
  _setClients: (r, s) => { resend = r; sendgrid = s; },
};
