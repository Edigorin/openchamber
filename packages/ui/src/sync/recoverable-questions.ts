/**
 * Recoverable questions: an agent's question whose ask died with its turn.
 *
 * When a turn stops or fails while its question tool waits for an answer,
 * OpenCode cancels the ask (`form.cancelled`) or drops it without a word (a
 * hard-killed process), and the question card disappears. The request itself
 * is gone server-side — a reply would come back "form not found" — but the
 * question the user never got to answer is still worth answering. This module
 * keeps that question and lets the user answer it as a NEW turn: the answer
 * travels as a normal message, never as a form reply.
 *
 * Settlement precedence is unchanged: `state.form` stays the authoritative
 * live blocking state, `form.settled` still removes a request, and nothing
 * here blocks a session, protects a cache, or holds a directory. What is kept
 * here is local, memory-only, and explicitly not a pending request.
 *
 * Recovery needs request-specific evidence, because `form.replied` and
 * `form.cancelled` collapse into one `form.settled` event and a request that
 * vanished during a disconnect may have been answered elsewhere. The linked
 * question tool call carries that evidence:
 *
 * - `completed` — the question was answered (possibly on another client).
 * - `error`, `type: "aborted"`, "Tool execution interrupted" — the turn died
 *   with the question still open. Recoverable.
 * - `error`, `errorSource: "local"` — this client's interrupted-turn
 *   reconciliation closed the call while the question was open. Recoverable,
 *   and revocable: an authoritative transition that arrives later wins.
 * - `error`, "Interaction cancelled because the location shut down" — the
 *   request was cancelled because OpenCode went away; the turn may resume
 *   (interruption reason `shutdown` is deliberately not a turn death), so this
 *   is never recovered.
 * - any other terminal error — a deliberate dismissal or a tool failure; not
 *   turn death, so never recovered.
 * - still `pending`/`running` with no death record — the turn may be running
 *   in another OpenCode process (openchamber#4156) or still resumable. Not
 *   recovered, and not tombstoned: a recorded death arriving later may still
 *   settle it.
 * - nothing loaded yet — unresolved; the derivation runs again when the
 *   transcript arrives. Unrecognized evidence fails closed (no card).
 *
 * Eligibility is structural: only ordinary session-owned question forms carry
 * the question tool's linkage (`metadata.kind === "question"` and
 * `metadata.tool`). Permission requests, web-search consent forms and MCP
 * elicitation (a `global` session id, no tool link) cannot produce a card, and
 * answering one of those as chat text would not perform its protocol step.
 *
 * Retention limit: memory only. A reload drops every captured question, and a
 * question asked while this client was not running is never captured.
 */

import { create } from "zustand"
import type { SyncEvent } from "@/lib/opencode/events"
import type { FormRequest, Part, ToolPart } from "@/lib/opencode/model"

/** Where a question form's ask linked to the tool call that made it. */
export type QuestionToolLink = {
  messageID: string
  toolID: string
}

/**
 * What happened to a question's ask. Only `turn-death` may be recovered;
 * every other outcome is a verdict the derivation re-reads each time.
 */
export type QuestionAskOutcome =
  | "answered"
  | "dismissed"
  | "turn-death"
  | "shutdown"
  /** The call still waits for an answer (or another process owns the turn). */
  | "pending"
  /** Evidence missing or unrecognized; never recovered. */
  | "unresolved"

/** Terminal verdicts that permanently hide a captured request. */
type RecoveredQuestionOutcome = "answered" | "dismissed" | "shutdown"

export type RecoveredQuestion = {
  form: FormRequest
  directory: string
  sessionID: string
  /** The assistant message whose question tool call died unanswered. */
  toolMessageID: string
  evidence: "tool-interrupted" | "local-interrupt-mark"
}

type SeenQuestion = {
  form: FormRequest
  directory: string
  sessionID: string
  tool: QuestionToolLink
}

type RecordedDisposition = {
  sessionID: string
  outcome: QuestionAskOutcome
}

type RecoverableQuestionsState = {
  /** Eligible question forms this client has observed, by request id. */
  seen: ReadonlyMap<string, SeenQuestion>
  /** Requests whose question must never be re-shown, by request id. */
  outcomes: ReadonlyMap<string, RecoveredQuestionOutcome>
  /** Terminal ask outcomes recorded from live events, by `messageID:toolID`. */
  dispositions: ReadonlyMap<string, RecordedDisposition>
  /** In-flight recovered-answer sends, by request id (duplicate-submission guard). */
  submissions: ReadonlyMap<string, Promise<void>>
}

const EMPTY_STATE: RecoverableQuestionsState = {
  seen: new Map(),
  outcomes: new Map(),
  dispositions: new Map(),
  submissions: new Map(),
}

export const useRecoverableQuestionsStore = create<RecoverableQuestionsState>(() => EMPTY_STATE)

const MAX_SEEN_QUESTIONS = 100

/** Runtime switches and tests start from nothing; see `apps/runtimeEndpointReset.ts`. */
export const resetRecoverableQuestions = (): void => {
  useRecoverableQuestionsStore.setState(EMPTY_STATE)
}

const toolKey = (tool: QuestionToolLink): string => `${tool.messageID}\u0000${tool.toolID}`

/** The question tool's stamp on a form's metadata, as OpenCode writes it. */
type QuestionToolMetadata = {
  kind?: string
  tool?: { messageID?: string; id?: string }
}

/**
 * The question tool's link from a form's metadata, or null for any form this
 * recovery cannot vouch for: a different kind, MCP elicitation, web-search
 * consent, or a client-created form with no tool call behind it. OpenCode's
 * question tool stamps `metadata.kind === "question"` and
 * `metadata.tool = { messageID, id }` (its wire tool call id, which is also
 * the tool part's id).
 */
export function questionToolLink(form: FormRequest): QuestionToolLink | null {
  // SAFETY: `FormMetadata` is OpenCode's open JSON bag because every tool
  // stamps its own keys; the question tool's stamp is the `{ kind: "question",
  // tool: { messageID, id } }` shape above, reproduced from the wire in
  // recoverable-questions.test.ts. The reader takes only those two strings and
  // treats anything else (wrong kind, missing or foreign tool value) as "not
  // a question", so a malformed stamp degrades to no recovery, never to a
  // wrong card.
  const metadata = form.metadata as QuestionToolMetadata | undefined
  if (metadata?.kind !== "question") return null
  const tool = metadata.tool
  if (!tool) return null
  const { messageID, id } = tool
  if (!messageID || !id) return null
  return { messageID, toolID: id }
}

// OpenCode's wording for the ends that decide recovery. Unrecognized text
// fails closed; see the module doc.
const TURN_DEATH_TOOL_ERROR = "Tool execution interrupted"
const SHUTDOWN_TOOL_ERROR = "Interaction cancelled because the location shut down"
const LOCAL_INTERRUPT_MARK = "Interrupted"

/**
 * Classifies a terminal tool error. `local` marks this client's own
 * interrupted-turn reconciliation, which only ever runs for a turn OpenCode
 * recorded dead, so it is turn death like the server's own interruption.
 */
export function classifyQuestionToolError(
  error: string,
  errorType: string | undefined,
  local: boolean,
): QuestionAskOutcome {
  if (local) return error === LOCAL_INTERRUPT_MARK ? "turn-death" : "unresolved"
  if (errorType === "aborted") {
    if (error === TURN_DEATH_TOOL_ERROR) return "turn-death"
    if (error === SHUTDOWN_TOOL_ERROR) return "shutdown"
    return "unresolved"
  }
  if (errorType !== undefined) return "dismissed"
  // Evidence flattened before error types were kept: only the exact known
  // markers are trusted, never a guess from prose. A local interrupted-turn
  // mark carries its own provenance (`errorSource`) and is not inferred here.
  if (error === TURN_DEATH_TOOL_ERROR) return "turn-death"
  if (error === SHUTDOWN_TOOL_ERROR) return "shutdown"
  return "unresolved"
}

function partAskOutcome(part: ToolPart | undefined): QuestionAskOutcome {
  const state = part?.state
  if (!state) return "unresolved"
  if (state.status === "completed") return "answered"
  if (state.status === "error") {
    return classifyQuestionToolError(state.error, state.errorType, state.errorSource === "local")
  }
  return "pending"
}

/**
 * The verdict for one captured ask: what live events recorded, else what the
 * transcript holds. The recorded event outcome wins so a late authoritative
 * transition revokes a card even where the reducer kept a locally manufactured
 * terminal state. Nothing loaded yet reads as unresolved and the derivation
 * runs again when the transcript arrives.
 */
function questionAskOutcome(
  part: ToolPart | undefined,
  recorded: QuestionAskOutcome | undefined,
): QuestionAskOutcome {
  if (recorded !== undefined) return recorded
  return partAskOutcome(part)
}

const findAskPart = (
  parts: Readonly<Record<string, readonly Part[] | undefined>>,
  tool: QuestionToolLink,
): ToolPart | undefined => {
  const part = parts[tool.messageID]?.find((candidate) => candidate.id === tool.toolID)
  return part?.type === "tool" ? part : undefined
}

export type RecoverableQuestionStateView = Pick<
  RecoverableQuestionsState,
  "seen" | "outcomes" | "dispositions"
>

export type RecoverableQuestionStoreView = {
  form: Readonly<Record<string, readonly FormRequest[] | undefined>>
  part: Readonly<Record<string, readonly Part[] | undefined>>
}

/**
 * The questions recoverable right now for one session scope: the session's own
 * and its subtree's, in capture order. Pure, so tests and the React hook read
 * the same verdicts.
 */
export function deriveRecoveredQuestions(
  state: RecoverableQuestionStoreView,
  recovery: RecoverableQuestionStateView,
  scopeSessionIds: ReadonlySet<string>,
): RecoveredQuestion[] {
  const recovered: RecoveredQuestion[] = []
  for (const [formID, seen] of recovery.seen) {
    if (recovery.outcomes.has(formID)) continue
    if (!scopeSessionIds.has(seen.sessionID)) continue
    const liveForms = state.form[seen.sessionID]
    if (liveForms?.some((form) => form.id === formID)) continue
    const part = findAskPart(state.part, seen.tool)
    const recorded = recovery.dispositions.get(toolKey(seen.tool))?.outcome
    const outcome = questionAskOutcome(part, recorded)
    if (outcome !== "turn-death") continue
    recovered.push({
      form: seen.form,
      directory: seen.directory,
      sessionID: seen.sessionID,
      toolMessageID: seen.tool.messageID,
      evidence: part?.state.status === "error" && part.state.errorSource === "local"
        ? "local-interrupt-mark"
        : "tool-interrupted",
    })
  }
  return recovered
}

/** Captures an eligible question form this client just observed. */
function noteQuestionFormSeen(form: FormRequest, directory: string): void {
  const tool = questionToolLink(form)
  if (!tool) return
  useRecoverableQuestionsStore.setState((state) => {
    if (state.seen.has(form.id)) return state
    const seen = new Map(state.seen)
    seen.set(form.id, { form, directory, sessionID: form.sessionID, tool })
    while (seen.size > MAX_SEEN_QUESTIONS) {
      const oldest = seen.keys().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
    return { seen }
  })
}

/**
 * Captures the eligible forms a pending-forms read returned. Absence carries
 * no meaning here; pending-ness is derived from the directory store, so a
 * fetch failure or a half-read snapshot cannot look like a settlement.
 */
export function noteQuestionFormSnapshot(directory: string, forms: readonly FormRequest[]): void {
  for (const form of forms) noteQuestionFormSeen(form, directory)
}

/** A reply this client confirmed: the question was answered, never re-shown. */
export function noteLocalFormReplied(formID: string): void {
  useRecoverableQuestionsStore.setState((state) => {
    const outcomes = new Map(state.outcomes)
    outcomes.set(formID, "answered")
    return { outcomes }
  })
}

/** A cancel this client confirmed (dismiss, or a send superseding the ask). */
export function noteLocalFormCancelled(formID: string): void {
  useRecoverableQuestionsStore.setState((state) => {
    const outcomes = new Map(state.outcomes)
    outcomes.set(formID, "dismissed")
    return { outcomes }
  })
}

/** The user dismissed a recovered card; the question never comes back. */
export function dismissRecoveredQuestion(formID: string): void {
  noteLocalFormCancelled(formID)
}

/** The recovered answer's send was accepted; the card is done. */
export function markRecoveredQuestionAnswered(formID: string): void {
  noteLocalFormReplied(formID)
}

/**
 * Runs a recovered answer's send under the request's submission lock: a second
 * submit while one is in flight returns the first promise instead of sending
 * the answer twice. The caller owns rollback and runtime checks inside `send`.
 */
export function submitRecoveredAnswer(formID: string, send: () => Promise<void>): Promise<void> {
  const state = useRecoverableQuestionsStore.getState()
  const existing = state.submissions.get(formID)
  if (existing) return existing
  const run = send().finally(() => {
    useRecoverableQuestionsStore.setState((current) => {
      const submissions = new Map(current.submissions)
      submissions.delete(formID)
      return { submissions }
    })
  })
  useRecoverableQuestionsStore.setState({ submissions: new Map(state.submissions).set(formID, run) })
  return run
}

const recordDisposition = (sessionID: string, tool: QuestionToolLink, outcome: QuestionAskOutcome): void => {
  useRecoverableQuestionsStore.setState((state) => {
    const dispositions = new Map(state.dispositions)
    dispositions.set(toolKey(tool), { sessionID, outcome })
    return { dispositions }
  })
}

const dropSession = (sessionID: string): void => {
  useRecoverableQuestionsStore.setState((state) => {
    const seen = new Map(state.seen)
    for (const [formID, entry] of seen) if (entry.sessionID === sessionID) seen.delete(formID)
    const outcomes = new Map(state.outcomes)
    for (const [formID] of outcomes) {
      if (state.seen.get(formID)?.sessionID === sessionID) outcomes.delete(formID)
    }
    const dispositions = new Map(state.dispositions)
    for (const [key, entry] of dispositions) if (entry.sessionID === sessionID) dispositions.delete(key)
    return { seen, outcomes, dispositions }
  })
}

/**
 * Applies one ordered batch of sync events. Same-batch creation and
 * settlement is safe: the capture happens on the creation event before the
 * settle is read, so the request is never lost between two publications.
 */
export function applyRecoverableQuestionEvents(directory: string, events: readonly SyncEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case "form.created":
        noteQuestionFormSeen(event.properties.form, directory)
        break
      case "form.settled":
        // Only an explicit reply is a verdict here. A cancellation is how a
        // turn's death settles its own ask and stays eligible for the tool
        // call's disposition to judge; a local cancel has its own veto.
        if (event.properties.disposition === "replied") noteLocalFormReplied(event.properties.formID)
        break
      case "message.tool.transition": {
        const { sessionID, messageID, partID, transition } = event.properties
        const tool: QuestionToolLink = { messageID, toolID: partID }
        if (transition.kind === "success") recordDisposition(sessionID, tool, "answered")
        else if (transition.kind === "failed") {
          recordDisposition(sessionID, tool, classifyQuestionToolError(
            transition.error,
            transition.errorType,
            false,
          ))
        }
        break
      }
      case "session.deleted":
        dropSession(event.properties.sessionID)
        break
      default:
        break
    }
  }
}
