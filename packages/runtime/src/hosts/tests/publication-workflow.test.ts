import { describe, expect, it } from "bun:test";
import { buildPublicationPlan, runtimeVersion } from "../../review/comment.js";
import type { ChangeRequestEventContext } from "../../types.js";
import {
  createPublicationWorkflow,
  type LoadedPublicationState,
  type PublicationDriver,
} from "../publication/workflow.js";

const change = {
  repository: { slug: "acme/widget" },
  change: {
    number: 42,
    base: { sha: "base" },
    head: { sha: "head" },
    isDraft: false,
  },
  workspace: "/tmp",
} as ChangeRequestEventContext;

function plan() {
  return buildPublicationPlan({
    event: change,
    main: "Summary.",
    inlineItems: [],
    reviewState: {
      version: 1,
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
      findings: [],
    },
    metadata: {
      runtimeVersion,
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
      failedTasks: [],
      validFindings: 0,
      droppedFindings: 0,
    },
  });
}

type Prepared = { change: ChangeRequestEventContext };

class MemoryDriver implements PublicationDriver<Prepared> {
  readonly provider = "Memory";
  currentHead = "head";
  writes: string[] = [];
  state: LoadedPublicationState = { inline: [], threads: [] };

  async prepare(input: ChangeRequestEventContext): Promise<Prepared> {
    return { change: input };
  }

  async assertCurrent(_prepared: Prepared, expectedHeadSha: string): Promise<void> {
    if (this.currentHead !== expectedHeadSha) throw new Error("head changed");
  }

  async loadOwnedState(): Promise<LoadedPublicationState> {
    return this.state;
  }

  async upsertMain(_prepared: Prepared, existing: { id: string } | undefined, body: string) {
    const id = existing?.id ?? "main-1";
    this.writes.push(existing ? "update-main" : "create-main");
    this.state = { ...this.state, main: { id, body } };
    return { id, action: existing ? ("updated" as const) : ("created" as const) };
  }

  inlineLocation(): never {
    throw new Error("no inline item expected");
  }

  async createInline(): Promise<void> {
    throw new Error("no inline item expected");
  }

  async loadOwnedCommand(): Promise<undefined> {
    return undefined;
  }

  async upsertCommand(): Promise<never> {
    throw new Error("no command expected");
  }

  async replyThread(): Promise<void> {
    throw new Error("no thread action expected");
  }
}

describe("shared publication workflow", () => {
  it("rejects a stale head before any write", async () => {
    const driver = new MemoryDriver();
    driver.currentHead = "new-head";
    const publication = createPublicationWorkflow(driver);

    await expect(publication.publish({ change, plan: plan() })).rejects.toThrow("head changed");
    expect(driver.writes).toEqual([]);
  });
});
