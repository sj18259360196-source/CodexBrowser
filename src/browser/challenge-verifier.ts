import type { HumanAssistance } from "../shared/contracts";
import type { BrowserChallengeEvidence, BrowserResourceProbeResult } from "./browser-adapter";
import { detectChallenge, shouldFreezeForChallenge } from "./challenge-detector";

export interface ChallengeVerificationResult {
  success: boolean;
  sanitizedReason: string;
  evidenceTypes: string[];
  checkedAt: string;
  retryable: boolean;
}

export function verifyChallengeResolution(
  assistance: HumanAssistance,
  before: BrowserChallengeEvidence,
  after: BrowserChallengeEvidence,
  probe?: BrowserResourceProbeResult,
): ChallengeVerificationResult {
  const detection = detectChallenge(after);
  const changed = before.mainFrameUrl !== after.mainFrameUrl
    || before.title !== after.title
    || before.domMarkers.join("|") !== after.domMarkers.join("|")
    || before.visibleText !== after.visibleText;
  const signals: string[] = [];
  if (!shouldFreezeForChallenge(detection)) signals.push("challenge_signals_cleared");
  if (changed) signals.push("page_changed");
  if (probe?.ok) signals.push("protected_resource_available");
  if (probe?.unauthorized) signals.push("protected_resource_unauthorized");
  const resourceRequired = assistance.verificationStrategy === "protected_resource";
  const success = !shouldFreezeForChallenge(detection) && changed && (!resourceRequired || probe?.ok === true);
  return {
    success,
    sanitizedReason: success
      ? "The user-interaction boundary is gone and the page reached a changed, usable state."
      : shouldFreezeForChallenge(detection)
        ? "The page still contains the original challenge or authentication boundary."
        : resourceRequired && !probe?.ok
          ? "The protected resource is still unavailable."
          : "The page has not changed enough to verify completion.",
    evidenceTypes: signals,
    checkedAt: new Date().toISOString(),
    retryable: true,
  };
}
