// 1.99aek (S1 widget polish, the owner's "fix the smaller things"): a signed-in member's chat pages ask the site for nothing
// that fails. Before it, on staging's /p/staff: /p/avatar.png and /p/staff/avatar.png (a fresh account's relative default
// picture, set as-is by the nav) and /public/img/badges/supporter-gold.png (the 💚 Supporter badge a line carries) were 404s;
// the bot badge (badges/bot) and a showcased achievement (ach/<id>) were 404s waiting to happen.
//   E2E_BASE_URL=... E2E_MEMBER_JWT=... npx playwright test -c tools/e2e     (README.md; both projects: desktop + iPhone)
"use strict";
const { test, expect } = require("@playwright/test");

const PAD = process.env.E2E_PAD || "staff";
const JWT = process.env.E2E_MEMBER_JWT || "";
// every icon key userlook.buildLooks sends (badgeicons.iconKeys - the achievements are a sample here; the unit test checks all)
const ICONS = ["badges/supporter-bronze", "badges/supporter-silver", "badges/supporter-gold", "badges/bot",
               "ach/cf_donor", "ach/cf_donor_100", "ach/cf_micclip_pepe"];

test.beforeAll(() => {
  if (!process.env.E2E_BASE_URL) throw new Error("set E2E_BASE_URL (tools/e2e/README.md)");
});

/** Sign the context in as the test member (its session cookie, on the site's own host). */
async function signIn(context, baseURL) {
  const u = new URL(baseURL);
  await context.addCookies([{ name: "jwt", value: JWT, domain: u.hostname, path: "/", httpOnly: true, secure: u.protocol === "https:", sameSite: "Lax" }]);
}
/** Every response from the site's own origin that failed (>= 400), as "status path" - the page loads included. */
function watchFailures(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const bad = [];
  page.on("response", (r) => {
    let u;
    try { u = new URL(r.url()); } catch (e) { return; }
    if (u.origin === origin && r.status() >= 400) bad.push(r.status() + " " + u.pathname);
  });
  return bad;
}

test("every badge icon the chat widget draws is a PNG at /public/img/<icon>.png", async ({ request }) => {
  for (const icon of ICONS) {
    const r = await request.get("/public/img/" + icon + ".png");
    expect(r.status(), icon).toBe(200);
    expect(r.headers()["content-type"], icon).toBe("image/png");
  }
  expect((await request.get("/public/img/ach/no-such-badge.png")).status()).toBe(404);
});

test.describe("signed in as a test member", () => {
  test.skip(!JWT, "E2E_MEMBER_JWT not set (a throwaway test member's session cookie)");

  test("the pad's Live chat, its mod page, the member's profile, the home page and the rankings load nothing that 404s", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL);
    const bad = watchFailures(page, baseURL);
    const failedLoads = [];
    page.on("console", (m) => { if (m.type() === "error" && /Failed to load resource/.test(m.text())) failedLoads.push(m.text().slice(0, 200)); });

    const res = await page.goto("/p/" + encodeURIComponent(PAD));
    expect(res.status(), "the member opens the pad").toBe(200);
    const chat = page.locator("patv-chat");
    if (await chat.count()) {
      await expect(chat).toHaveAttribute("data-state", "mounted", { timeout: 30000 });
      await page.waitForTimeout(4000);                          // its lines (and their badges) arrive after the mount
    }
    const me = await page.locator(".navbar .avatar a").getAttribute("href");
    expect(me, "signed in: the nav links the member's profile").toMatch(/^\/u\/[^/]+$/);

    for (const p of ["/p/" + encodeURIComponent(PAD) + "/mod", me, "/", "/rankings"]) {
      const r = await page.goto(p);
      expect(r.status(), p).toBeLessThan(400);
      await page.waitForTimeout(2500);
    }
    expect(bad, "no request to the site failed").toEqual([]);
    expect(failedLoads, "no 'Failed to load resource' in the console").toEqual([]);
  });

  test("the nav picture is a loaded image at a site path or https - never the relative avatar.png", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL);
    await page.goto("/p/" + encodeURIComponent(PAD));
    const img = page.locator("#userAvatar");
    await expect(img).toHaveAttribute("src", /^(\/(?!\/)|https:\/\/)/);
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth > 0), { timeout: 15000 }).toBe(true);
    const me = (await page.locator(".navbar .avatar a").getAttribute("href")).slice(3);
    const r = await page.request.get("/api/u/" + me + "/profile");
    expect(r.status()).toBe(200);
    expect((await r.json()).avatar).toMatch(/^(\/(?!\/)|https:\/\/)/);
  });
});
