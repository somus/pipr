import { describe, expect, it } from "bun:test";
import { definePipr } from "@usepipr/sdk";
import { buildPiprPlan } from "@usepipr/sdk/internal";
import {
  dispatchRuntimeEntry,
  parsePlanCommandInputs,
  permissionDeniedHelp,
  resolvePlanCommand,
  selectLocalReviewTasks,
} from "../entry-dispatch.js";

describe("entry dispatch command routing", () => {
  it("selects change-request tasks", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        const review = pipr.task({ name: "review", run() {} });
        const audit = pipr.task({ name: "audit", run() {} });
        const ready = pipr.task({ name: "ready", run() {} });
        pipr.on.changeRequest({ actions: ["updated"], task: review });
        pipr.on.changeRequest({ actions: ["updated"], task: audit });
        pipr.on.changeRequest({ actions: ["ready"], task: ready });
      }),
    );

    expect(
      dispatchRuntimeEntry({ kind: "change-request", plan, event: { action: "updated" } }),
    ).toMatchObject({
      kind: "change-request",
      tasks: [{ name: "review" }, { name: "audit" }],
    });
    expect(
      dispatchRuntimeEntry({ kind: "change-request", plan, event: {}, taskName: "audit" }),
    ).toMatchObject({
      kind: "change-request",
      tasks: [{ name: "audit" }],
    });
  });

  it("selects unique local review tasks and skips local-disabled tasks", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        const review = pipr.task({ name: "review", run() {} });
        const audit = pipr.task({ name: "audit", local: false, run() {} });
        pipr.on.changeRequest({ actions: ["opened"], task: review });
        pipr.on.changeRequest({ actions: ["updated"], task: review });
        pipr.on.changeRequest({ actions: ["ready"], task: audit });
      }),
    );

    expect(selectLocalReviewTasks(plan).map((task) => task.name)).toEqual(["review"]);
  });

  it("matches required positional and optional named arguments into task inputs", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        const task = pipr.task<{ finding: string; scope: "changed" | "full" }>({
          name: "explain",
          run() {},
        });
        pipr.command({
          pattern: "@pipr explain <finding> [--scope <scope>]",
          permission: "read",
          task,
          parse(arguments_) {
            const scope = arguments_.scope ?? "changed";
            if (scope !== "changed" && scope !== "full") {
              throw new Error("scope must be changed or full");
            }
            const narrowedScope: "changed" | "full" = scope;
            return { finding: arguments_.finding, scope: narrowedScope };
          },
        });
      }),
    );

    expect(resolvePlanCommand(plan, "@pipr explain FND-123")).toMatchObject({
      kind: "matched",
      invocation: {
        taskName: "explain",
        commandName: "explain",
        arguments: { finding: "FND-123" },
      },
    });
    const full = resolvePlanCommand(plan, "@pipr explain FND-123 --scope full");
    expect(full).toMatchObject({
      kind: "matched",
      invocation: {
        arguments: { finding: "FND-123", scope: "full" },
      },
    });
    expect(
      full.kind === "matched" ? parsePlanCommandInputs(plan, full.invocation) : full,
    ).toMatchObject({
      kind: "matched",
      invocation: {
        inputs: { finding: "FND-123", scope: "full" },
      },
    });
    const invalid = resolvePlanCommand(plan, "@pipr explain FND-123 --scope all");
    expect(
      invalid.kind === "matched" ? parsePlanCommandInputs(plan, invalid.invocation) : invalid,
    ).toMatchObject({
      kind: "invalid",
      reason: "scope must be changed or full",
    });
  });

  it("ignores non-pipr comments and renders permission denial help", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        const task = pipr.task({ name: "review", run() {} });
        pipr.command({ pattern: "@pipr review", task });
      }),
    );

    expect(resolvePlanCommand(plan, "@piprbot review")).toMatchObject({
      kind: "ignored",
      reason: "comment did not target pipr",
    });
    expect(permissionDeniedHelp(plan, "write")).toContain("Permission denied");
  });

  it("matches a later longer command when an earlier prefix command rejects extra args", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        const review = pipr.task({ name: "review", run() {} });
        const explain = pipr.task({ name: "explain", run() {} });
        pipr.command({ pattern: "@pipr review", task: review });
        pipr.command({ pattern: "@pipr review <finding>", permission: "read", task: explain });
      }),
    );

    expect(resolvePlanCommand(plan, "@pipr review FND-123")).toMatchObject({
      kind: "matched",
      invocation: {
        taskName: "explain",
        arguments: { finding: "FND-123" },
      },
    });
  });
});
