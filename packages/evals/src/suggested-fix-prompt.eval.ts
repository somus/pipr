import { evalite } from "evalite";
import { assertLiveEvalEnv } from "./env.js";
import { livePromptGateEvalConfig, suggestedFixLivePromptGate } from "./live-prompt-gates.js";

assertLiveEvalEnv();

evalite(suggestedFixLivePromptGate.name, livePromptGateEvalConfig(suggestedFixLivePromptGate));
