// tools/i18n-providers.js - 1.99kf: the model behind tools/i18n-sync.js. A provider is an object
//   { name, model, complete({ system, prompt, maxTokens }) -> Promise<{ text, truncated }> }
// so the sync tool (and its tests, with a mock) never care which API answers.
//
//   I18N_PROVIDER=anthropic (default)   ANTHROPIC_API_KEY, I18N_MODEL (default claude-haiku-5-5), ANTHROPIC_BASE_URL (optional)
//   I18N_PROVIDER=openai                any OpenAI-compatible /chat/completions endpoint (the homelab Ollama / llama-server):
//                                       I18N_OPENAI_BASE_URL (e.g. http://192.168.1.152:11434/v1), I18N_MODEL (required),
//                                       I18N_OPENAI_API_KEY (optional), I18N_OPENAI_EXTRA (optional JSON merged into the
//                                       request body, e.g. {"chat_template_kwargs":{"enable_thinking":false}})
// Keys only ever come from the environment; nothing here prints them.
"use strict";

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST JSON with retries on 429 / 5xx / network errors (backoff 2 s, 6 s, 18 s). */
async function postJson(url, headers, body, { attempts = 4, timeoutMs = 180000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(2000 * Math.pow(3, i - 1));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers), body: JSON.stringify(body), signal: ctl.signal });
      const text = await r.text();
      if (r.ok) return JSON.parse(text);
      last = new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
      if (r.status !== 429 && r.status < 500) throw Object.assign(last, { fatal: true });
    } catch (e) {
      if (e.fatal) throw e;
      last = e.name === "AbortError" ? new Error("timed out") : e;
    } finally { clearTimeout(timer); }
  }
  throw last;
}

function anthropic(env, opts = {}) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error("ANTHROPIC_API_KEY is not set (or use I18N_PROVIDER=openai with I18N_OPENAI_BASE_URL)"), { code: "NO_KEY" });
  const model = opts.model || env.I18N_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const base = (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  return {
    name: "anthropic", model,
    async complete({ system, prompt, maxTokens = 8192 }) {
      const j = await postJson(base + "/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" },
        // no `temperature`: current Claude models (claude-haiku-5-5, the default) reject non-default sampling with a 400
        { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] });
      const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      return { text, truncated: j.stop_reason === "max_tokens" };
    },
  };
}

function openai(env, opts = {}) {
  const base = (env.I18N_OPENAI_BASE_URL || "").replace(/\/+$/, "");
  const model = opts.model || env.I18N_MODEL;
  if (!base || !model) throw Object.assign(new Error("I18N_PROVIDER=openai needs I18N_OPENAI_BASE_URL and I18N_MODEL"), { code: "NO_KEY" });
  let extra = {};
  if (env.I18N_OPENAI_EXTRA) { try { extra = JSON.parse(env.I18N_OPENAI_EXTRA); } catch (e) { throw new Error("I18N_OPENAI_EXTRA is not JSON"); } }
  const headers = env.I18N_OPENAI_API_KEY ? { authorization: "Bearer " + env.I18N_OPENAI_API_KEY } : {};
  // Streamed: a local model that reasons first can take minutes before its answer, longer than fetch waits for
  // response headers (300 s). A stream sends headers at once. Reasoning deltas are ignored; only content is kept.
  async function streamed(body) {
    let last;
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(5000 * i);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1800000);
      try {
        const r = await fetch(base + "/chat/completions", { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers),
          body: JSON.stringify(Object.assign({}, body, { stream: true })), signal: ctl.signal });
        if (!r.ok) {
          last = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
          if (r.status !== 429 && r.status < 500) throw Object.assign(last, { fatal: true });
          continue;
        }
        let buf = "", text = "", finish = null;
        const dec = new TextDecoder();
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const ch = (JSON.parse(data).choices || [])[0] || {};
              if (ch.delta && typeof ch.delta.content === "string") text += ch.delta.content;
              if (ch.finish_reason) finish = ch.finish_reason;
            } catch (e) { /* a keep-alive or partial line */ }
          }
        }
        return { text, truncated: finish === "length" };
      } catch (e) {
        if (e.fatal) throw e;
        last = e.name === "AbortError" ? new Error("timed out") : e;
      } finally { clearTimeout(timer); }
    }
    throw last;
  }
  return {
    name: "openai", model,
    async complete({ system, prompt, maxTokens = 8192 }) {
      return streamed(Object.assign({ model, temperature: 0.2, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }, extra));
    },
  };
}

/** The provider the environment (or --provider / --model) asks for. Throws {code: "NO_KEY"} when it can't run. */
function fromEnv(env = process.env, opts = {}) {
  const which = (opts.provider || env.I18N_PROVIDER || "anthropic").toLowerCase();
  if (which === "anthropic") return anthropic(env, opts);
  if (which === "openai" || which === "ollama") return openai(env, opts);
  throw new Error("unknown I18N_PROVIDER " + which + " (anthropic | openai)");
}

module.exports = { fromEnv, anthropic, openai, DEFAULT_ANTHROPIC_MODEL };
