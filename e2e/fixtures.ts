// Custom Playwright fixture: opts every e2e test out of the baked-in Drive
// defaults so the dev server's static /comics/ fallback is used. Tests can
// still navigate to the setup screen and configure Drive explicitly if needed.
import { test as base, expect } from "@playwright/test";

export const test = base.extend<{}>({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem(
          "netcomix.config.v1",
          JSON.stringify({ __forceStatic: true }),
        );
      } catch {
        // ignore
      }
    });
    await use(page);
  },
});

export { expect };
