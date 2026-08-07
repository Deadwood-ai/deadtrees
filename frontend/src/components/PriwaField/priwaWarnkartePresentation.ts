import { PriwaWarnkarteApiError } from "../../api/priwaWarnkarte";

export const formatPriwaWarnkarteDate = (value: string | null) => {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
};

export const formatPriwaWarnkarteError = (error: unknown) => {
  if (!(error instanceof PriwaWarnkarteApiError)) {
    return error instanceof Error
      ? error.message
      : "Die Warnkarten-Anfrage ist fehlgeschlagen.";
  }

  const expected = error.details.expected;
  const detected = error.details.detected;
  if (error.code === "INVALID_CRS") {
    return `${error.message} Erwartet: ${String(expected)}. Erkannt: ${
      detected ? String(detected) : "nicht angegeben"
    }.`;
  }
  return error.message;
};
