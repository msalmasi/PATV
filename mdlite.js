// mdlite.js - 1.99qa: a tiny, safe Markdown -> HTML renderer for the docs the styleguide hub shows (docs/brand.md).
// Not a general Markdown engine: it handles what our docs use - #..#### headings (with ids), paragraphs, - / 1. lists
// (one nesting level by indentation), > quotes, ``` fences, | tables |, ---, and inline `code`, **bold**, *italic*,
// [text](href). SAFETY: every piece of source text is HTML-escaped before any markup is added, so raw HTML in a doc
// renders as text; links only allow http(s), site-relative (/...) and #anchor hrefs, and doc-relative .md links are
// sent to the repo on GitHub. No dependency (the site has no markdown package and the VPS updater doesn't npm install).
"use strict";

const REPO_BLOB = "https://github.com/msalmasi/PATV/blob/staging/docs/";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function slug(s) {
  return String(s).toLowerCase().replace(/`/g, "").replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-") || "s";
}

function safeHref(h) {
  h = String(h).trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("#")) return h;
  if (h.startsWith("/") && !h.startsWith("//")) return h;
  if (/^[\w./-]+\.md(#[\w-]*)?$/.test(h)) return REPO_BLOB + h.replace(/^\.\//, "");
  return null;
}

// Inline markup on ALREADY-ESCAPED text. Code spans are pulled out first so their contents stay literal.
function inline(raw) {
  const codes = [];
  let s = esc(raw).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, href) => {
    const h = safeHref(href.replace(/&amp;/g, "&"));
    if (!h) return txt;
    const ext = /^https?:/i.test(h);
    return '<a href="' + esc(h) + '"' + (ext ? ' rel="noopener" target="_blank"' : "") + ">" + txt + "</a>";
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[+i] + "</code>");
}

function splitRow(line) {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  // split on | that isn't inside backticks or escaped
  const cells = []; let cur = "", tick = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (ch === "\\" && l[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "`") tick = !tick;
    if (ch === "|" && !tick) { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * render(md) -> { html, toc: [{level, id, text}] }
 * Headings get unique ids; toc lists h2/h3 (plain text, escaped later by the view).
 */
function render(md) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const out = [], toc = [], used = new Map();
  let i = 0;
  const uid = (t) => { const b = slug(t); const n = used.get(b) || 0; used.set(b, n + 1); return n ? b + "-" + n : b; };
  const isBlockStart = (l) => /^(#{1,6}\s|```|>|\s*([-*]|\d+\.)\s|\|)/.test(l) || /^-{3,}\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m;
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      const lv = m[1].length, id = uid(m[2]);
      const plain = m[2].replace(/`/g, "").replace(/\*\*/g, "");
      if (lv === 2 || lv === 3) toc.push({ level: lv, id, text: plain });
      out.push("<h" + lv + ' id="' + id + '">' + inline(m[2]) + "</h" + lv + ">");
      i++; continue;
    }
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
      continue;
    }
    if (/^-{3,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push("<blockquote>" + render(buf.join("\n")).html + "</blockquote>");
      continue;
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = splitRow(line); i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push('<div class="ds-tbl"><table><thead><tr>' + head.map((c) => "<th>" + inline(c) + "</th>").join("") +
        "</tr></thead><tbody>" + rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table></div>");
      continue;
    }
    if ((m = /^(\s*)([-*]|\d+\.)\s+/.exec(line))) {
      // a list: items at the base indent; deeper-indented items become one nested list under the previous item
      const ordered = /\d/.test(m[2]);
      const base = m[1].length;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const mm = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);
        if (mm && mm[1].length <= base) { items.push({ text: mm[3], sub: [] }); i++; continue; }
        if (mm && mm[1].length > base && items.length) { items[items.length - 1].sub.push(l.slice(base + 2)); i++; continue; }
        if (l.trim() && /^\s{2,}\S/.test(l) && items.length && !mm) { // continuation line
          const it = items[items.length - 1];
          if (it.sub.length) it.sub[it.sub.length - 1] += " " + l.trim(); else it.text += " " + l.trim();
          i++; continue;
        }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      const task = items.some((it) => /^\[[ xX]\]\s/.test(it.text));
      const li = (it) => { // "- [ ] item" task lists render a box glyph (read-only checklists)
        const m2 = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
        return m2 ? '<span class="md-cb" aria-hidden="true">' + (m2[1] === " " ? "☐" : "☑") + "</span> " + inline(m2[2]) : inline(it.text);
      };
      out.push("<" + tag + (task ? ' class="md-tasks"' : "") + ">" + items.map((it) => "<li>" + li(it) + (it.sub.length ? render(it.sub.join("\n")).html : "") + "</li>").join("") + "</" + tag + ">");
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i]))) buf.push(lines[i++].trim());
    out.push("<p>" + inline(buf.join(" ")) + "</p>");
  }
  return { html: out.join("\n"), toc };
}

/**
 * sections(md) -> [{ n, title, md }]: the doc split at its "## " headings (the intro before the first one is n = 0).
 * n is the leading number of the heading ("## 5. Pepe" -> 5), or null when the heading has none.
 */
function sections(md) {
  const parts = []; let cur = { n: 0, title: "", lines: [] };
  for (const l of String(md).replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^##\s+(?:(\d+)\.\s+)?(.*)$/.exec(l);
    if (m && !l.startsWith("###")) { parts.push(cur); cur = { n: m[1] ? +m[1] : null, title: m[2].trim(), lines: [l] }; continue; }
    cur.lines.push(l);
  }
  parts.push(cur);
  return parts.map((p) => ({ n: p.n, title: p.title, md: p.lines.join("\n") }));
}

module.exports = { render, sections, esc, slug, safeHref };
