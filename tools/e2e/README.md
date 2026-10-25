# Real-browser checks (Playwright)

Since S1, a change a member sees is done only when a real browser shows it, on a desktop and on a phone. These specs run
that check against a running site. They are not part of `npm test` (the unit tests in `test/` are).

This folder has **no package.json on purpose**: the deploy updater runs `npm ci` in every folder whose package.json changes,
and Playwright has no business on the server. Bring your own install, for example:

```sh
npm i --prefix ~/pw @playwright/test@1.64.0 && npx --prefix ~/pw playwright install chromium webkit
NODE_PATH=~/pw/node_modules E2E_BASE_URL=https://staging.publicaccess.tv E2E_MEMBER_JWT=... \
  ~/pw/node_modules/.bin/playwright test -c tools/e2e
```

| Variable | |
|---|---|
| `E2E_BASE_URL` | the site: `https://staging.publicaccess.tv`, or a local boot (`http://localhost:3000`). Required. |
| `E2E_MEMBER_JWT` | the `jwt` session cookie of a **throwaway test member** on that site. Never a real account, never printed, never committed. Without it the signed-in specs skip. |
| `E2E_PAD` | a hub pad's slug the member can open (default `staff`). |
| `E2E_IPHONE_ENGINE` | `webkit` or `chromium` for the iPhone project. Default: WebKit on https, Chromium on plain http (WebKit drops the site's `Secure` login cookie there). |

Projects: `desktop` (Desktop Chrome) and `iphone` (iPhone 15 viewport, touch, mobile UA). No traces or videos are kept:
they would hold the session cookie. A failure keeps its screenshot under `test-results/` (git-ignored).

| Spec | Checks |
|---|---|
| `specs/widget-assets.spec.js` | 1.99aek: the chat widget's badge icons exist (`/public/img/badges/supporter-*.png`, `badges/bot.png`, `/public/img/ach/<id>.png`); a signed-in member's hub pad (Live chat), its `/mod` page, their profile, the home page and `/rankings` request nothing that fails; the nav picture is never the relative `avatar.png` |
