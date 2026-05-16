import { expect, test } from "./fixtures";

test.describe("NetComix visual journey (watch this)", () => {
  test("full reading flow end-to-end", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(800);
    await expect(page.getByTestId("library-view")).toBeVisible();

    // Favorite the series
    await page.getByTestId("series-card-demo-series").first().locator(".card-fav").click();
    await page.waitForTimeout(500);

    // Drill in
    await page.getByTestId("series-card-demo-series").first().click();
    await page.waitForTimeout(800);
    await expect(page.getByTestId("series-view")).toBeVisible();

    // Open issue 1
    await page.getByTestId("issue-card-issue-01").click();
    await page.waitForTimeout(1000);
    await expect(page.getByTestId("reader")).toBeVisible();

    // Walk through the snap loop: cover → page2 → panel1 → ... → page3
    for (let i = 0; i < 7; i++) {
      await page.getByTestId("next-btn").click();
      await page.waitForTimeout(700);
    }

    // Open HUD with a center tap and play with settings
    const box = await page.getByTestId("reader").boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(600);
      await expect(page.getByTestId("hud")).toBeVisible();

      // Slide opacity
      const slider = page.getByTestId("opacity-slider");
      await slider.focus();
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(60);
      }

      // Switch button position
      await page.getByTestId("position-select").selectOption("sides");
      await page.waitForTimeout(500);

      // Close HUD
      await page.getByTestId("hud-close").click();
      await page.waitForTimeout(500);
    }

    // Walk back a couple steps
    for (let i = 0; i < 3; i++) {
      await page.getByTestId("prev-btn").click();
      await page.waitForTimeout(600);
    }

    // Open HUD, go back to series view, then library
    const finalBox = await page.getByTestId("reader").boundingBox();
    if (finalBox) {
      await page.mouse.click(finalBox.x + finalBox.width / 2, finalBox.y + finalBox.height / 2);
      await page.waitForTimeout(600);
      await page.getByTestId("hud-back").click();
      await page.waitForTimeout(700);
    }
    await expect(page.getByTestId("series-view")).toBeVisible();
    await page.getByTestId("back-btn").click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("library-view")).toBeVisible();
  });

  test("mobile viewport — reader at 375x812", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    const p = await ctx.newPage();
    await p.goto("/");
    await p.waitForTimeout(600);
    await p.getByTestId("series-card-demo-series").click();
    await p.waitForTimeout(600);
    await p.getByTestId("issue-card-issue-01").click();
    await p.waitForTimeout(800);
    for (let i = 0; i < 4; i++) {
      await p.getByTestId("next-btn").click();
      await p.waitForTimeout(600);
    }
    await expect(p.getByTestId("reader")).toBeVisible();
    await ctx.close();
  });
});
