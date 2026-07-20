import { expect, test } from "@playwright/test";
import rootPackage from "../../../../package.json" with { type: "json" };
import { inspectWebp } from "../../scripts/og-images";

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

test("serves production canonical and social metadata", async ({ page }) => {
  await assertMetadata(page, "/", "https://pipr.run/", "website", "/og/docs/image.webp");
  await assertMetadata(
    page,
    "/docs/guide/quickstart",
    "https://pipr.run/docs/guide/quickstart",
    "article",
    "/og/docs/guide/quickstart/image.webp",
  );
});

test("shows current quickstart and recipe interactions without mobile overflow", async ({
  page,
}) => {
  await page.goto("/docs/guide/quickstart");
  await expect(page.getByText(`PIPR_VERSION=v${rootPackage.version}`)).toBeVisible();
  await expect(page.getByRole("link", { name: "Pi's Model Catalog" })).toHaveAttribute(
    "href",
    "https://pi.dev/models",
  );

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/docs/recipes/fix-suggestions");
  const workflowTab = page.getByRole("tab", { name: "pipr.yml" });
  await workflowTab.click();
  await expect(workflowTab).toHaveAttribute("data-state", "active");
  await expect(page.getByRole("tabpanel", { name: "pipr.yml" })).toContainText("name: pipr");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("serves valid OG images and portable machine-readable documentation", async ({ request }) => {
  for (const imagePath of ["/og/docs/image.webp", "/og/docs/reference/sdk-reference/image.webp"]) {
    const response = await request.get(imagePath);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/webp");
    expect(inspectWebp(new Uint8Array(await response.body()))).toEqual({
      height: 630,
      width: 1200,
    });
  }

  const sdkMarkdown = await (await request.get("/docs/reference/sdk-reference.md")).text();
  const fullMarkdown = await (await request.get("/llms-full.txt")).text();
  for (const markdown of [sdkMarkdown, fullMarkdown]) {
    expect(markdown).not.toContain("<TypeTable");
    expect(markdown).not.toContain("type-table-");
    expect(markdown).not.toContain('"entries": [');
    expect(markdown).not.toContain("<RecipeFileExplorer");
    expect(markdown).not.toContain("<RecipeFilePane");
  }
  expect(sdkMarkdown).toContain("| Property | Type | Required | Description |");
  expect(sdkMarkdown).toContain("### ModelOptions");
  expect(sdkMarkdown).toContain("thinking");
  expect(fullMarkdown).toContain("pipr.review({");
  expect(fullMarkdown).toContain("name: pipr");
});

test("searches generated type information without leaking component names", async ({ page }) => {
  await page.goto("/docs/reference/sdk-reference");
  await page.getByRole("button", { name: /^Search/ }).click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  const input = dialog.getByPlaceholder("Search");

  await input.fill("ModelOptions");
  await expect(dialog.getByText(/ModelOptions/).first()).toBeVisible();

  await input.fill("typetable");
  await expect(dialog.getByText("No results found")).toBeVisible();
});

async function assertMetadata(
  page: import("@playwright/test").Page,
  route: string,
  canonicalUrl: string,
  type: "article" | "website",
  imagePath: string,
): Promise<void> {
  await page.goto(route);
  const canonical = page.locator('link[rel="canonical"]');
  const ogUrl = page.locator('meta[property="og:url"]');
  const ogImage = page.locator('meta[property="og:image"]');
  const twitterImage = page.locator('meta[name="twitter:image"]');
  const expectedImage = `https://pipr.run${imagePath}`;

  await expect(canonical).toHaveCount(1);
  await expect(canonical).toHaveAttribute("href", canonicalUrl);
  await expect(ogUrl).toHaveCount(1);
  await expect(ogUrl).toHaveAttribute("content", canonicalUrl);
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", type);
  await expect(ogImage).toHaveCount(1);
  await expect(ogImage).toHaveAttribute("content", expectedImage);
  await expect(twitterImage).toHaveCount(1);
  await expect(twitterImage).toHaveAttribute("content", expectedImage);
  await expect(page.locator('meta[name="description"]')).toHaveCount(1);
}
