import utf8 from "utf8";

/**
 * Fixes UTF-8 encoding issues in text strings
 * Attempts to decode incorrectly encoded text and re-encode it properly
 * @param text - The text that may have encoding issues
 * @returns Clean UTF-8 text or the original text if no issues detected
 */
export const fixTextEncoding = (text: string): string => {
  if (!text) return text;

  try {
    // Check if the text contains common encoding issue indicators
    const hasEncodingIssues =
      /[��◆�]/.test(text) ||
      /\uFFFD/.test(text) || // Unicode replacement character
      /[\u00C2-\u00C3][\u0080-\u00BF]/.test(text); // Common double-encoding pattern

    if (!hasEncodingIssues) {
      return text;
    }

    // Try to fix common encoding issues

    // Method 1: Try to decode as if it was incorrectly encoded as ISO-8859-1
    try {
      const decoded = utf8.decode(text);
      if (decoded !== text && !hasEncodingIssues) {
        return decoded;
      }
    } catch (e) {
      // Failed to decode, try other methods
    }

    // Method 2: Try to fix double-encoded UTF-8
    try {
      const bytes = new TextEncoder().encode(text);
      const fixed = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (fixed !== text && !/[��◆�]/.test(fixed)) {
        return fixed;
      }
    } catch (e) {
      // Failed to fix
    }

    // Method 3: Remove problematic characters and replace with spaces
    const cleaned = text
      .replace(/[��◆�\uFFFD]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    return cleaned || text; // Return cleaned text or original if cleaning resulted in empty string
  } catch (error) {
    console.warn("Error fixing text encoding:", error);
    return text; // Return original text if all else fails
  }
};

/**
 * Fixes encoding issues specifically in author names
 * @param authors - Array of author names that may have encoding issues
 * @returns Array of cleaned author names
 */
export const fixAuthorNamesEncoding = (authors: string[] | null | undefined): string[] => {
  if (!authors || !Array.isArray(authors)) return [];

  return authors.map((author) => fixTextEncoding(author)).filter(Boolean);
};

/**
 * Fixes encoding issues in any text field
 * @param text - Text that may have encoding issues
 * @returns Cleaned text
 */
export const sanitizeText = (text: string | null | undefined): string => {
  if (!text) return "";

  return fixTextEncoding(text);
};

/**
 * Batch fixes encoding issues in an object's text properties
 * @param obj - Object with text properties that may have encoding issues
 * @param textFields - Array of field names to clean
 * @returns Object with cleaned text fields
 */
export const fixObjectTextEncoding = <T extends Record<string, any>>(obj: T, textFields: (keyof T)[]): T => {
  const cleaned = { ...obj };

  textFields.forEach((field) => {
    if (typeof cleaned[field] === "string") {
      cleaned[field] = fixTextEncoding(cleaned[field] as string) as T[keyof T];
    } else if (Array.isArray(cleaned[field]) && cleaned[field].every((item: any) => typeof item === "string")) {
      cleaned[field] = fixAuthorNamesEncoding(cleaned[field] as string[]) as T[keyof T];
    }
  });

  return cleaned;
};
