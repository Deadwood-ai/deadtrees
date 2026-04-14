/**
 * Extracts ORCID ID from various input formats (URL or direct ID)
 * @param input - ORCID URL or ID string
 * @returns Clean ORCID ID or null if invalid
 */
export function extractOrcidId(input: string): string | null {
  if (!input) return null;

  // Remove whitespace
  let orcidId = input.replace(/\s/g, "");

  // Check if it's a full ORCID URL and extract the ID
  const orcidUrlPattern = /(?:https?:\/\/)?(?:www\.)?orcid\.org\/(.+)/i;
  const match = orcidId.match(orcidUrlPattern);

  if (match) {
    orcidId = match[1]; // Extract just the ORCID ID part
  }

  return orcidId;
}

/**
 * Validates ORCID ID format
 * @param orcidId - ORCID ID to validate
 * @returns boolean indicating if format is valid
 */
export function isValidOrcidId(orcidId: string): boolean {
  if (!orcidId) return false;

  // ORCID ID format: 0000-0000-0000-000X (where X can be a digit or X)
  const orcidIdPattern = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
  return orcidIdPattern.test(orcidId);
}

/**
 * Processes ORCID input: extracts ID and validates format
 * @param input - Raw ORCID input (URL or ID)
 * @returns Object with extracted ID and validation status
 */
export function processOrcidInput(input: string): {
  orcidId: string | null;
  isValid: boolean;
  error?: string;
} {
  const orcidId = extractOrcidId(input);

  if (!orcidId) {
    return {
      orcidId: null,
      isValid: false,
      error: "Please enter an ORCID ID or URL",
    };
  }

  const isValid = isValidOrcidId(orcidId);

  return {
    orcidId,
    isValid,
    error: isValid ? undefined : "Please enter a valid ORCID ID format (e.g., 0000-0002-1825-0097)",
  };
}
