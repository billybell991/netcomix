import { expect, test } from "@playwright/test";

const CONSOLE_NOISE = [
  "Download the React DevTools",
  "Warning:",
  "next-dev.js",
  "Failed to load resource",
  "CLIENT_FETCH_ERROR",
  "Failed to fetch",
];

test.describe("NetComix critical path", () => {
  test("library page loads and shows demo series", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && !CONSOLE_NOISE.some((n) => msg.text().includes(n))) {
        errors.push(msg.text());
      }
    });
    await page.goto("/");
    await expect(page.getByTestId("library-view")).toBeVisible();
    await expect(page.getByTestId("series-card-demo-series")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("series view → issue list", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("series-card-demo-series").click();
    await expect(page.getByTestId("series-view")).toBeVisible();
    await expect(page.getByTestId("issue-card-issue-01")).toBeVisible();
    await expect(page.getByTestId("issue-card-issue-02")).toBeVisible();
  });

  test("back button returns to library", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("series-card-demo-series").click();
    await page.getByTestId("back-btn").click();
    await expect(page.getByTestId("library-view")).toBeVisible();
  });

  test("opens a reader and shows the first page", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("series-card-demo-series").click();
    await page.getByTestId("issue-card-issue-01").click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await expect(page.getByTestId("page-image")).toBeVisible();
    await expect(page.getByTestId("next-btn")).toBeVisible();
    await expect(page.getByTestId("prev-btn")).toBeVisible();
  });

  test("snap loop: cover → next page → first panel → second panel", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("series-card-demo-series").click();
    await page.getByTestId("issue-card-issue-01").click();
    const img = page.getByTestId("page-image");
    // Cover (page 0 full)
    const srcCover = await img.getAttribute("src");
    // Next → page 2 full (different src — same fit transform is fine)
    await page.getByTestId("next-btn").click();
    await page.waitForTimeout(450);
    const srcPage2 = await img.getAttribute("src");
    expect(srcPage2).not.toBe(srcCover);
    const tFull = await img.evaluate((el) => (el as HTMLElement).style.transform);
    // Next → snap to first panel on page 2 — src stays same, transform changes
    await page.getByTestId("next-btn").click();
    await page.waitForTimeout(450);
    const tPanel = await img.evaluate((el) => (el as HTMLElement).style.transform);
    expect(tPanel).not.toBe(tFull);
    // Next → second panel — transform changes again
    await page.getByTestId("next-btn").click();
    await page.waitForTimeout(450);
    const tPanel2 = await img.evaluate((el) => (el as HTMLElement).style.transform);
    expect(tPanel2).not.toBe(tPanel);
  });

  test("HUD opens with center tap and closes", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("series-card-demo-series").click();
    await page.getByTestId("issue-card-issue-01").click();
    const box = await page.getByTestId("reader").boundingBox();
    if (!box) throw new Error("no bounding box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId("hud")).toBeVisible();
    await page.getByTestId("hud-close").click();
    await expect(page.getByTestId("hud")).toBeHidden();
  });

  test("HUD settings persist across reloads", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("series-card-demo-series").click();
    await page.getByTestId("issue-card-issue-01").click();
    const box = await page.getByTestId("reader").boundingBox();
    if (!box) throw new Error("no bounding box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByTestId("sounds-toggle").click();
    // Reload, re-navigate (we don't persist route — only settings & progress)
    await page.reload();
    await page.getByTestId("series-card-demo-series").first().click();
    await page.getByTestId("issue-card-issue-01").click();
    const box2 = await page.getByTestId("reader").boundingBox();
    if (!box2) throw new Error("no bounding box 2");
    await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await expect(page.getByTestId("sounds-toggle")).not.toBeChecked();
  });

  test("favorites toggle persists", async ({ page }) => {
    await page.goto("/");
    const favBtn = page.getByTestId("series-card-demo-series").locator(".card-fav").first();
    await favBtn.click();
    await page.reload();
    await expect(
      page.getByTestId("series-card-demo-series").locator(".card-fav.on").first()
    ).toBeVisible();
  });

  test("library.json is served", async ({ page }) => {
    const res = await page.request.get("/netcomix/comics/library.json");
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.series.length).toBeGreaterThan(0);
  });

  test("PWA manifest is served", async ({ page }) => {
    const res = await page.request.get("/netcomix/manifest.webmanifest");
    expect(res.status()).toBe(200);
  });

  test("mobile viewport renders library", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const p = await ctx.newPage();
    await p.goto("/");
    await expect(p.getByTestId("library-view")).toBeVisible();
    await ctx.close();
  });

  test("page load under 5 seconds", async ({ page }) => {
    const start = Date.now();
    await page.goto("/", { waitUntil: "networkidle" });
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
