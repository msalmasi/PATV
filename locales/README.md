# Site translations

`en.json` is the source. Every other `<code>.json` is a machine translation (`_meta.machine: true`). A string missing
from a catalog shows in English.

## Adding or changing a string

1. Put the English in `locales/en.json`. Keys are `area.name`, values are HTML-safe text. Use `{name}` for an escaped
   value, `{!name}` for markup you built yourself, and `{"one": "...", "other": "..."}` with `{count}` for plurals.
   Don't put a `"` outside a tag. `js.*` keys are plain text.
2. Use it:
   - in a view, `<%- t('area.name', { name }) %>` (the view starts with the shared prelude, see `i18n-core.js`)
   - in server code, `req.t('area.name')`
   - in page scripts, `__t('js.area.name', 'English default', vars)`. The default must equal `en.json`.
3. Commit and push to `staging`. Don't translate by hand. Don't write the literal text `[skip ci]` anywhere in your
   commit message: GitHub then runs no workflow for the push, so the sync doesn't run either.

## What happens automatically

- **The sync.** `.github/workflows/i18n-sync.yml` runs `tools/i18n-sync.js --all` on every push to `staging` that
  changes `en.json` or `glossary.json`. It works through the strings in batches:
  - It translates only what is **missing** from a catalog, or **changed**: strings whose English differs from the
    English they were translated from. `.i18n-state.json` keeps a hash for each one.
  - The model sees `glossary.json` (brand names that are kept as written, the site's own words such as pad, stage and
    wheel, and per-language style notes) plus a few strings already on the site as examples.
  - It checks every answer with `i18n-check.js` before writing it: the same placeholders, exactly the same HTML tags,
    no stray quotes or markup, and plural forms intact. A bad answer is retried once and then skipped, so that string
    shows in English.
  - It runs `test/i18n.test.js` and then commits the catalogs back to `staging` as **one** follow-up commit
    (`i18n: translate new strings ... [skip ci]`).
- **One deploy, not two.** The VPS updater holds a commit that changed `en.json` for up to 8 minutes while it waits
  for that follow-up (`I18N_HOLD_SECS` in `deploy/patv-update.sh`; 0 turns it off). Promoting `staging` to `main`
  carries the translations along.
- **Pull requests** get a warning that lists the strings with no translation yet. So does the main CI job. This is
  only a warning, because English is the fallback.
- **The secret.** The workflow needs the repository secret `ANTHROPIC_API_KEY`
  (Settings > Secrets and variables > Actions). Without it, the job skips with a notice. The default model is
  `claude-haiku-5-5`; set the repository variable `I18N_MODEL` to use another.

## By hand

```
node tools/i18n-sync.js --check                 # what's missing or stale (no model needed)
node tools/i18n-sync.js --dry-run --lang=es     # what a sync would translate
node tools/i18n-sync.js --lang=es,fr --max-keys=20
node tools/i18n-sync.js --all
node tools/i18n-sync.js --glossary              # refresh the glossary's per-language terms from the catalogs
node tools/i18n-sync.js --lock=es:nav.feed      # mark a hand-fixed string human-reviewed (--unlock=...)
node tools/i18n-sync.js --init                  # after editing a catalog by hand: count today's text as current
```

The tool uses Anthropic when `ANTHROPIC_API_KEY` is set. It can also use any OpenAI-compatible endpoint, such as the
homelab Ollama or llama-server:

```
I18N_PROVIDER=openai I18N_OPENAI_BASE_URL=http://192.168.1.152:8080/v1 I18N_MODEL=glm-5.3-flash \
  node tools/i18n-sync.js --all --concurrency=3 --batch=12
```

Replies are streamed, so a slow local model isn't cut off. One language runs at a time unless you pass
`--concurrency`. `I18N_OPENAI_EXTRA` takes JSON that is merged into each request. The local GLM always reasons before
it answers: about 2 minutes per batch, which makes a full run take hours. For anything big, use the API.

## Feedback from users

1. Someone browsing in another language uses the footer link **Suggest a better translation**, which opens
   `/translate`. That page lists the strings of the page they just left, plus a search over every string. They see
   the English and the current translation, and can send a better one with an optional note. Signed-in users only,
   20 per hour and 100 per day. Suggestions are checked with the same rules.
2. Admins review them at **`/admin/translations`**. **Accept**, as written or edited, puts the text live at once as
   an *override* on top of the catalog (table `translation_overrides`, applied by `i18n.setOverrides`). **Reject**
   drops it. An override stops applying once the English it was made for changes.
3. To make overrides permanent:
   1. Use **Download the overrides** on that page, then run
      `node tools/i18n-overrides.js fold translation-overrides-<date>.json`. This writes the overrides into the
      catalogs and marks them **human-reviewed** in `.i18n-state.json`, so the sync never overwrites them. If their
      English changes later, the sync only reports "needs a human".
   2. Commit, push to `staging`, and promote.
   3. Press **Clear the ones already in the catalogs** on the admin page.
