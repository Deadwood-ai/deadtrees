// A spreadsheet runs a cell as a formula when its text starts with one of
// these characters (OWASP "CSV injection"). Exported text comes from users.
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

/**
 * Quote one CSV cell. Text that a spreadsheet would run as a formula gets a
 * leading apostrophe; numbers stay as they are, so negative coordinates are
 * unchanged.
 */
export const escapeCsvCell = (value: string | number | boolean | null | undefined) => {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (typeof value === "string" && FORMULA_TRIGGERS.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
};
