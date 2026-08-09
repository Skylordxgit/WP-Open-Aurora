/**
 * Shared server-side text template renderer.
 *
 * Substitutes Handlebars-style `{{name}}` placeholders with values from the
 * provided `vars` map. Placeholders whose key is absent from `vars` are left
 * untouched (the literal `{{key}}` is preserved) so that missing variables are
 * visible rather than silently blanked.
 *
 * NOTE: bulk-message.service.ts ships an independent single-brace `{name}`
 * renderer (see `applyVariables`). The two placeholder conventions
 * (`{{name}}` here vs `{name}` there) should be reconciled into this shared
 * helper in a follow-up so the gateway exposes one consistent templating
 * syntax. See issue #69.
 */

const PLACEHOLDER_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Render a template body by replacing `{{key}}` placeholders with `vars[key]`.
 *
 * @param body Template text containing `{{key}}` placeholders.
 * @param vars Map of placeholder keys to substitution values.
 * @returns The rendered text with known placeholders substituted and unknown
 *          placeholders left as literal `{{key}}`.
 */
export function renderTemplate(body: string, vars: Record<string, string> = {}): string {
  if (!body) {
    return body;
  }

  return body.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null) {
      return String(vars[key]);
    }
    // Leave unmatched placeholders literal so missing variables stay visible.
    return match;
  });
}
