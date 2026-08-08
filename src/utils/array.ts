/** Splits `items` into consecutive chunks of at most `size` elements. */
export function chunk<T>(items: ReadonlyArray<T>, size: number): Array<Array<T>> {
  if (size < 1) throw new RangeError("chunk size must be >= 1");
  const chunks: Array<Array<T>> = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
