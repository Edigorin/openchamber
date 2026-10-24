import { describe, expect, test } from 'bun:test';

import { PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';
import { resolveAssistantErrorText } from './assistantError';

// The phantom notice the aborted fallback renders today; it stays for every
// message except the one whose question was recovered.
const ABORTED_NOTICE = 'The running turn was stopped before OpenCode could send the next message.';

describe('assistant error text', () => {
  test('renders the aborted fallback for a message with no recovered question', () => {
    expect(resolveAssistantErrorText({
      isUser: false,
      isFollowedByAssistant: false,
      detail: 'aborted',
      isSessionRetry: false,
      recoveredQuestion: false,
    })).toEqual({ text: ABORTED_NOTICE });
  });

  test('steps aside only for the precisely correlated orphan case', () => {
    expect(resolveAssistantErrorText({
      isUser: false,
      isFollowedByAssistant: false,
      detail: 'aborted',
      isSessionRetry: false,
      recoveredQuestion: true,
    })).toBeUndefined();
  });

  test('keeps every other error, recovered question or not', () => {
    for (const recoveredQuestion of [false, true]) {
      expect(resolveAssistantErrorText({
        isUser: false,
        isFollowedByAssistant: false,
        detail: 'The usage limit has been reached',
        isSessionRetry: false,
        recoveredQuestion,
      })).toEqual({ text: 'Opencode failed to send message with error: The usage limit has been reached' });

      expect(resolveAssistantErrorText({
        isUser: false,
        isFollowedByAssistant: false,
        detail: 'Step interrupted',
        isSessionRetry: false,
        recoveredQuestion,
      })).toEqual({ text: 'Opencode failed to send message with error: Step interrupted' });
    }
  });

  test('keeps the retry and provider-auth branches', () => {
    expect(resolveAssistantErrorText({
      isUser: false,
      isFollowedByAssistant: false,
      detail: 'rate limited',
      isSessionRetry: true,
      recoveredQuestion: false,
    })).toEqual({ text: 'Opencode failed to send a message. Retry attempt info: rate limited' });

    expect(resolveAssistantErrorText({
      isUser: false,
      isFollowedByAssistant: false,
      detail: '401 unauthorized',
      isSessionRetry: false,
      recoveredQuestion: false,
    })).toEqual({ text: PROVIDER_AUTH_FAILURE_MESSAGE });
  });

  test('shows nothing for the user message or a step the turn carried on from', () => {
    expect(resolveAssistantErrorText({
      isUser: true,
      isFollowedByAssistant: false,
      detail: 'aborted',
      isSessionRetry: false,
      recoveredQuestion: false,
    })).toBeUndefined();

    expect(resolveAssistantErrorText({
      isUser: false,
      isFollowedByAssistant: true,
      detail: 'aborted',
      isSessionRetry: false,
      recoveredQuestion: false,
    })).toBeUndefined();

    expect(resolveAssistantErrorText({
      isUser: false,
      isFollowedByAssistant: false,
      detail: undefined,
      isSessionRetry: false,
      recoveredQuestion: false,
    })).toBeUndefined();
  });
});
