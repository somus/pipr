import { runAgentWorkerCommand } from "./process.js";

await runAgentWorkerCommand(process.argv.slice(2));
