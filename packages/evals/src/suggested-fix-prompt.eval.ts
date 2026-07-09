import { evalite } from "evalite";
import {
  assertLiveEvalEnv,
  livePromptGateEvalConfig,
  suggestedFixLivePromptGate,
} from "./live-prompt-gates.js";

assertLiveEvalEnv();

evalite(suggestedFixLivePromptGate.name, livePromptGateEvalConfig(suggestedFixLivePromptGate));
