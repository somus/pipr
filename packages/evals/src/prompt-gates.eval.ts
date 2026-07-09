import { evalite } from "evalite";
import {
  assertLiveEvalEnv,
  cleanSuppressionLivePromptGate,
  defectRecallLivePromptGate,
  livePromptGateEvalConfig,
  safetyHygieneLivePromptGate,
  suggestedFixLivePromptGate,
} from "./live-prompt-gates.js";

assertLiveEvalEnv();

for (const gate of [
  suggestedFixLivePromptGate,
  defectRecallLivePromptGate,
  cleanSuppressionLivePromptGate,
  safetyHygieneLivePromptGate,
]) {
  evalite(gate.name, livePromptGateEvalConfig(gate));
}
