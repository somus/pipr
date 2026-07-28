import { describe, expect, it } from "bun:test";
import { createAzureDevOpsWebhookProtocol } from "../webhook.js";

describe("Azure DevOps webhook protocol", () => {
  it("resolves the authenticated host instance separately from the collection", async () => {
    const requests: string[] = [];
    const protocol = createAzureDevOpsWebhookProtocol(async (input) => {
      const url = String(input);
      requests.push(url);
      return Response.json(
        url.includes("/git/repositories/")
          ? {
              id: "repository-id",
              name: "repository",
              project: { id: "project-id", name: "project" },
            }
          : {
              authenticatedUser: {},
              instanceId: "host-instance-id",
            },
      );
    });

    await expect(
      protocol.resolveExpectedRepository(
        {
          AZURE_DEVOPS_COLLECTION_URL: "https://azure.example.test/tfs/DefaultCollection",
          AZURE_DEVOPS_PROJECT: "project",
          AZURE_DEVOPS_TOKEN: "token",
          PIPR_AZURE_SUBSCRIPTION_ID: "subscription-id",
        },
        "repository",
      ),
    ).resolves.toEqual({
      organization: "DefaultCollection",
      collectionUrl: "https://azure.example.test/tfs/DefaultCollection",
      instanceId: "host-instance-id",
      projectId: "project-id",
      repositoryId: "repository-id",
      subscriptionId: "subscription-id",
    });
    expect(requests).toHaveLength(2);
  });
});
