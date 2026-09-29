/**
 * Part-number normalisation (REPART_BRIEF.md §5): uppercase, spaces and dashes
 * stripped for matching; the original string is kept separately for display.
 */
export function normalizePartNumber(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, "");
}
