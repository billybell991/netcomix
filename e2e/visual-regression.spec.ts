import { expect, test } from "@playwright/test";

test.describe("Visual regression — pixel baselines", () => {
  test("library — desktop", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot("library-desktop.png", { fullPage: true });
  });

  test("series view — desktop", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("series-card-demo-series").click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot("series-desktop.png", { fullPage: true });
  });

  test("reader — cover", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("series-card-demo-series").click();
    await page.getByTestId("issue-card-issue-01").click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot("reader-cover.png");
  });

  test("reader — first panel snap", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("series-card-demo-series").click();
    await page.getByTestId("issue-card-issue-01").click();
    await page.waitForTimeout(500);
    // Cover → next page (full) → first panel
    await page.getByTestId("next-btn").click();
    await page.waitForTimeout(500);
    await page.getByTestId("next-btn").click();
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot("reader-panel-1.png");
  });

  test("HUD open", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("series-card-demo-series").click();
    await page.getByTestId("issue-card-issue-01").click();
    await page.waitForTimeout(500);
    const box = await page.getByTestId("reader").boundingBox();
    if (!box) throw new Error("no bounding box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot("reader-hud.png");
  });

  test("library — mobile viewport", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const p = await ctx.newPage();
    await p.goto("/");
    await p.waitForLoadState("networkidle");
    await p.waitForTimeout(400);
    await expect(p).toHaveScreenshot("library-mobile.png", { fullPage: true });
    await ctx.close();
  });
});
