#!/usr/bin/env bun
import { test } from "bun:test";
import { run, sourceRoot } from "./scenarios.ts";

test("passes deterministic prompt evals", () => {
  run("bun", ["run", "--cwd", "packages/evals", "eval:deterministic:run"], sourceRoot);
});
