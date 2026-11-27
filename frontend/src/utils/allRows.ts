/** The rows of one API answer; throws the API's error. */
export function unwrap<T>(result: { data: T[] | null; error: { code?: string; message: string } | null }): T[] {
  if (result.error) throw result.error;
  return result.data ?? [];
}

// the server answers at most this many rows per request (max_rows, supabase/config.toml)
const PAGE = 1000;

export type Rows<T> = PromiseLike<{ data: T[] | null; error: { code?: string; message: string } | null }>;

/** Every row of a query, page after page; `page` orders the query and asks for rows from..to. */
export async function allRows<T>(page: (from: number, to: number) => Rows<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const part = unwrap(await page(from, from + PAGE - 1));
    rows.push(...part);
    if (part.length < PAGE) return rows;
  }
}
