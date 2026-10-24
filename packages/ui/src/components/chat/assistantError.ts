/**
 * What an assistant message's error renders as.
 *
 * The decision lives here, out of `ChatMessage`, so the exact behavior can be
 * pinned in tests: which errors become which notice, and when the phantom
 * "aborted" notice steps aside for a recovered question card that replaces it.
 */

import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';

export type AssistantErrorDisplay = { text: string };

export type AssistantErrorDecision = {
  /** The message is the user's own; its failures are never shown this way. */
  isUser: boolean;
  /** A later assistant step carries the turn on; this step's error stays hidden. */
  isFollowedByAssistant: boolean;
  /** The error's detail text: `data.message`, `message`, or `name`, in that order. */
  detail: string | undefined;
  isSessionRetry: boolean;
  /**
   * A recovered question card stands for this message's unanswered ask. Its
   * notice ("your answer will start a new turn") replaces the phantom
   * "aborted" text for this message only; every other error still renders.
   */
  recoveredQuestion: boolean;
};

export function resolveAssistantErrorText(decision: AssistantErrorDecision): AssistantErrorDisplay | undefined {
  const { isUser, isFollowedByAssistant, detail, isSessionRetry, recoveredQuestion } = decision;
  if (isUser || isFollowedByAssistant) return undefined;
  if (!detail) return undefined;
  if (isSessionRetry) {
    return { text: `Opencode failed to send a message. Retry attempt info: ${detail}` };
  }
  if (isLikelyProviderAuthFailure(detail)) {
    return { text: PROVIDER_AUTH_FAILURE_MESSAGE };
  }
  if (detail.trim().toLowerCase() === 'aborted') {
    return recoveredQuestion
      ? undefined
      : { text: 'The running turn was stopped before OpenCode could send the next message.' };
  }
  return { text: `Opencode failed to send message with error: ${detail}` };
}
