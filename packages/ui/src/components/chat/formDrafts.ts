/**
 * Form answers in progress, shared across every surface that renders the same
 * request.
 *
 * One question can appear at once in its own chat's dock, in a parent's chat,
 * and in the BTW sheet; switching between them unmounts a panel and must not
 * throw half-filled answers away. Drafts are keyed by the request's full scope
 * — runtime, directory, session, request — so a draft from another runtime or
 * another request can never leak in, and a recovered question keeps its answer
 * across a failed send.
 *
 * Memory only: a reload starts every form over.
 */

import type { FormValues } from './formCardState';
import { getRuntimeKey } from '@/lib/runtime-switch';

export type FormDraftScope = {
  runtimeKey: string;
  directory: string;
  sessionID: string;
  formID: string;
};

export type FormDraft = {
  fieldsSignature: string;
  values: FormValues;
  step: number;
};

const formDrafts = new Map<string, FormDraft>();
const MAX_FORM_DRAFTS = 50;

const scopeKey = (scope: FormDraftScope): string =>
  [scope.runtimeKey, scope.directory, scope.sessionID, scope.formID].join('\u0000');

/**
 * The scope one form's draft lives under on a surface: this runtime, this
 * directory, this session's request. A draft can only be restored into the
 * exact place it was left.
 */
export function formDraftScope(form: { id: string; sessionID: string }, directory?: string): FormDraftScope {
  return {
    runtimeKey: getRuntimeKey(),
    directory: directory ?? '',
    sessionID: form.sessionID,
    formID: form.id,
  };
}

/** The saved draft for this exact scope and field shape, or null. */
export function loadFormDraft(scope: FormDraftScope): FormDraft | null {
  const draft = formDrafts.get(scopeKey(scope));
  return draft ?? null;
}

export function saveFormDraft(scope: FormDraftScope, draft: FormDraft): void {
  const key = scopeKey(scope);
  formDrafts.delete(key);
  formDrafts.set(key, draft);
  if (formDrafts.size > MAX_FORM_DRAFTS) {
    const oldest = formDrafts.keys().next().value;
    if (oldest !== undefined) formDrafts.delete(oldest);
  }
}

/** The answer is settled (sent or the question dismissed); the draft is done. */
export function dropFormDraft(scope: FormDraftScope): void {
  formDrafts.delete(scopeKey(scope));
}

export function resetFormDrafts(): void {
  formDrafts.clear();
}
