import { expect, test } from "@playwright/test";

test("serves hydrated home and documentation routes", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("link", { name: "Quickstart" }).first()).toBeVisible();

  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "Pipr", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Run the GitHub quickstart" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
