// Real-browser checks of the v1 site (1.99aek: S1's lesson - a client-facing change is done when a real browser shows it, on a
// desktop AND a phone viewport). Not part of `npm test` and not a dependency of the site: the deploy runs `npm ci` wherever a
// package.json changes, so this folder has none - run it with a Playwright install of your own (README.md here).
//
//   E2E_BASE_URL       the site to check: https://staging.publicaccess.tv, or a local boot (http://localhost:3000)   (required)
//   E2E_MEMBER_JWT     the `jwt` session cookie of a THROWAWAY test member on that site (never a real account; never print it).
//                      Without it the signed-in checks skip and the signed-out ones still run.
//   E2E_PAD            a hub pad's slug the member can open (default: staff)
//   E2E_IPHONE_ENGINE  webkit | chromium - the iPhone project's engine (default webkit on https; chromium on plain http,
//                      where WebKit drops the site's Secure login cookie)
"use strict";
const { defineConfig, devices } = require("@playwright/test");

const BASE = String(process.env.E2E_BASE_URL || "").replace(/\/+$/, "");
const iphoneEngine = process.env.E2E_IPHONE_ENGINE || (/^https:/.test(BASE) ? "webkit" : "chromium");
const { defaultBrowserType, ...iphone } = devices["iPhone 15"];   // eslint-disable-line no-unused-vars

module.exports = defineConfig({
  testDir: "./specs",
  outputDir: require("path").join(__dirname, "test-results"),   // failure screenshots (git-ignored here)
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE || undefined,
    actionTimeout: 15000,
    // no traces or videos: they would hold the test member's session cookie
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], browserName: "chromium" } },
    { name: "iphone", use: { ...iphone, browserName: iphoneEngine } },
  ],
});
