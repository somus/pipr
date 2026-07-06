#!/usr/bin/env bun
import { run, sourceRoot } from "./scenarios.ts";

run("bun", ["run", "--cwd", "packages/evals", "eval:deterministic:run"], sourceRoot);
