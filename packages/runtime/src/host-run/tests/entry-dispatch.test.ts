import { describe, expect, it } from "bun:test";
import { definePipr } from "@usepipr/sdk";
import { buildPiprPlan } from "@usepipr/sdk/internal";
import type { RepositoryPermission } from "../../hosts/types.js";
import { selectRuntimeTasks } from "../../review/task/select-runtime-tasks.js";
import {
  hasRequiredRepositoryPermission,
  parsePlanCommandInputs,
  permissionDeniedHelp,
  resolvePlanCommand,
} from "../entry-dispatch.js";

describe("entry dispatch command routing", () => {
  it("selects change-request tasks", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        pipr.task({ name: "review", on: { changeRequest: ["updated"] }, run() {} });
        pipr.task({ name: "audit", on: { changeRequest: ["updated"] }, run() {} });
        pipr.task({ name: "ready", on: { changeRequest: ["ready"] }, run() {} });
      }),
    );

    expect(
      selectRuntimeTasks({ plan, event: { action: "updated" } }).map((task) => task.name),
    ).toEqual(["review", "audit"]);
    expect(
      selectRuntimeTasks({ plan, event: {}, taskName: "audit" }).map((task) => task.name),
    ).toEqual(["audit"]);
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

  it.each<[RepositoryPermission, boolean]>([
    ["admin", true],
    ["maintain", true],
    ["write", true],
    ["triage", false],
    ["read", false],
    ["none", false],
  ])("checks %s against a write command", (actual, allowed) => {
    expect(hasRequiredRepositoryPermission(actual, "write")).toBe(allowed);
  });

  it("denies read commands to commenters without repository permission", () => {
    expect(hasRequiredRepositoryPermission("none", "read")).toBe(false);
  });
});
