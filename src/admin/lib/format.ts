/**
 * Pure, framework-free display helpers for the admin reviews UI. Kept
 * dependency-free (no `@medusajs/ui`, no React) so they can be unit tested
 * directly under `npm run test:unit` without a component-rendering harness.
 */

const MAX_STARS = 5

/**
 * Renders a 1-5 star rating as a fixed-width five-character glyph string.
 *
 * Clamped rather than a naive `'★'.repeat(rating)`: bad data (0, a stale
 * rating above 5, a negative value from a bug elsewhere) must never produce
 * a string longer or shorter than five characters, or the table column it
 * renders into breaks layout. `Math.round` also tolerates a non-integer
 * rating without throwing.
 */
export function formatStars(rating: number): string {
  const filled = Math.max(0, Math.min(MAX_STARS, Math.round(rating)))
  return '★'.repeat(filled) + '☆'.repeat(MAX_STARS - filled)
}

/**
 * Truncates `text` to at most `max` characters, breaking on the last word
 * boundary within that limit rather than mid-word, and appends an ellipsis.
 * Text already within the limit is returned unchanged (no trailing
 * ellipsis added where none is needed).
 */
export function excerpt(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }

  const truncated = text.slice(0, max)
  const lastSpace = truncated.lastIndexOf(' ')
  const base = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated

  return `${base}…`
}
