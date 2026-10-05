/**
 * Message template rendering — placeholders are explicit `{{variables}}`.
 * Rendering is strict: a body whose placeholders cannot be filled for a lead
 * is an error, never a silently half-rendered message.
 */

export class TemplateRenderError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`template placeholders have no value: ${missing.join(', ')}`);
    this.name = 'TemplateRenderError';
    this.missing = missing;
  }
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function extractPlaceholders(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !found.includes(name)) found.push(name);
  }
  return found;
}

/** Renders `{{var}}` placeholders; throws TemplateRenderError when any are missing. */
export function renderTemplate(body: string, variables: Readonly<Record<string, string>>): string {
  const missing: string[] = [];
  const rendered = body.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      missing.push(name);
      return whole;
    }
    return value;
  });
  if (missing.length > 0) throw new TemplateRenderError(missing);
  return rendered;
}
