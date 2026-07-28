import { describe, expect, it } from "bun:test";
import { createGiteaWebhookProtocol } from "../webhook.js";

describe("Gitea-compatible webhook protocol", () => {
  it("resolves the configured repository through the native API", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const protocol = createGiteaWebhookProtocol("forgejo", async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return Response.json({
        id: 42,
        full_name: "acme/pipr",
        html_url: "https://forge.example.com/acme/pipr",
      });
    });

    await expect(
      protocol.resolveExpectedRepository(
        {
          FORGEJO_TOKEN: "test-token",
          FORGEJO_SERVER_URL: "https://forge.example.com",
        },
        "acme/pipr",
      ),
    ).resolves.toEqual({ id: 42, fullName: "acme/pipr" });
    expect(requests).toEqual([
      {
        url: "https://forge.example.com/api/v1/repos/acme/pipr",
        authorization: "token test-token",
      },
    ]);
  });
});
