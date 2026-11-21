/**
 * Reads every row of a query that the API returns in pages of at most `pageSize` rows.
 * `fetchPage(from, to)` gets one inclusive row range; reading stops at the first short page.
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<T[] | null>,
  pageSize: number,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = (await fetchPage(from, from + pageSize - 1)) ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
