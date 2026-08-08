const WRAPPING_CODE_FENCE_REGEX = /^(```|~~~)[^\r\n]*\r?\n([\s\S]*)\r?\n\1$/;

/** Removes a single wrapping markdown code fence (``` or ~~~), if present. */
export function stripWrappingMarkdownCodeFence(markdown: string): string {
  const trimmed = markdown.trim();
  const match = trimmed.match(WRAPPING_CODE_FENCE_REGEX);
  return match ? (match[2] ?? "").trim() : markdown;
}

/** Collapses runs of whitespace into single spaces and trims. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Lowercases, strips diacritics (NFD), trims, and collapses whitespace. */
export function removeDiacritics(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/** Truncates to `maxLength`, replacing the tail with "..." when needed. */
export function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

export function levenshteinDistance(source: string, target: string): number {
  if (source === target) return 0;
  if (!source.length) return target.length;
  if (!target.length) return source.length;

  const matrix = Array.from({ length: source.length + 1 }, (_, row) => [row]);
  for (let column = 0; column <= target.length; column += 1) {
    matrix[0]![column] = column;
  }

  for (let row = 1; row <= source.length; row += 1) {
    for (let column = 1; column <= target.length; column += 1) {
      const substitutionCost = source[row - 1] === target[column - 1] ? 0 : 1;
      matrix[row]![column] = Math.min(
        matrix[row - 1]![column]! + 1,
        matrix[row]![column - 1]! + 1,
        matrix[row - 1]![column - 1]! + substitutionCost,
      );
    }
  }

  return matrix[source.length]![target.length]!;
}
