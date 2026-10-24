import type { FormValue } from '@opencode/client';
import type { FormRequest } from '@/lib/opencode/model';

/**
 * Pure serializers for a form request, so the user can carry an agent's
 * question into another tool (a companion model, an issue, a doc).
 * React-free so they can be unit-tested without the card.
 */

const RECOMMENDED_MARKER = /\s*\(recommended\)\s*/i;

/** Whether an option label carries the agent's "(recommended)" marker. */
export const isRecommendedOption = (label: string): boolean => RECOMMENDED_MARKER.test(label);

/** The option label without the "(recommended)" marker; the card shows a badge instead. */
export const stripRecommendedMarker = (label: string): string => label.replace(RECOMMENDED_MARKER, ' ').trim();

/**
 * Markdown, one section per field:
 *
 *   ## <title or key>
 *
 *   <description>
 *
 *   _Select all that apply._        (multiselect only)
 *
 *   - **<label>** — <description>   (options; description elided when blank)
 */
export function serializeFormAsMarkdown(form: FormRequest): string {
  const lines: string[] = [];
  const title = form.title.trim();
  if (title) {
    lines.push(`# ${title}`, '');
  }
  for (const field of form.fields) {
    lines.push(`## ${field.title?.trim() || field.key}`, '');
    const description = field.description?.trim();
    if (description) lines.push(description, '');
    if (field.type === 'external') {
      lines.push(`<${field.url}>`, '');
      continue;
    }
    if (field.type === 'multiselect') lines.push('_Select all that apply._', '');
    const options = field.type === 'multiselect' || field.type === 'string' ? field.options ?? [] : [];
    for (const option of options) {
      const optionDescription = option.description?.trim();
      lines.push(optionDescription ? `- **${option.label}** — ${optionDescription}` : `- **${option.label}**`);
    }
    if (options.length > 0) lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * A stable JSON envelope of the form's content: the transient `id` and
 * `sessionID` are local routing concerns and stay out.
 */
export function serializeFormAsJson(form: FormRequest): string {
  return JSON.stringify({ title: form.title, fields: form.fields }, null, 2);
}

/**
 * The answer to a question whose ask died with its turn, as the body of the
 * new turn that replaces it: the question's context so the agent knows what
 * was asked, the rendered answers, and the `buildFormAnswer` payload itself so
 * nothing is lost to prose. Numbers and booleans keep their shape, a multiselect
 * lists every pick including a typed custom answer, and a field hidden by its
 * `when` clause is absent because the answer carries none.
 */
export function serializeFormAnswerAsMarkdown(form: FormRequest, answer: Record<string, FormValue>): string {
  const lines: string[] = [];
  const title = form.title.trim();
  if (title) {
    lines.push(`# ${title}`, '');
  }
  for (const field of form.fields) {
    const value = answer[field.key];
    if (value === undefined) continue;
    lines.push(`## ${field.title?.trim() || field.key}`, '');
    const description = field.description?.trim();
    if (description) lines.push(description, '');
    lines.push(`**Answer:** ${renderAnswerValue(value)}`, '');
  }
  lines.push('```json', JSON.stringify(answer), '```');
  return lines.join('\n').trimEnd();
}

function renderAnswerValue(value: FormValue): string {
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
