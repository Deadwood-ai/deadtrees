import re

# Supabase access and refresh JWTs: three base64url segments, the header always
# starting with '{"' (eyJ). Signatures may be empty for unsigned tokens.
_JWT = re.compile(r'eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*')

REDACTED_TOKEN = '[redacted-token]'


def redact_tokens(text: str) -> str:
	"""Remove bearer tokens from text that leaves the process.

	Error messages and logs are stored in the database, shown in the Factory UI
	and sent to Linear, so they must never carry a usable credential.
	"""
	return _JWT.sub(REDACTED_TOKEN, text)


# Postgres text cannot hold NUL, and JSON with an unpaired surrogate is rejected,
# so either one in an error message makes the whole status or log write fail.
_UNSTORABLE = re.compile('[\x00\ud800-\udfff]')
_TRUNCATION_MARK = '\n[... truncated ...]\n'


def storable_text(text: str, max_chars: int | None = None) -> str:
	"""Redact tokens and make text safe to store, keeping its start and end if truncated.

	Tool output keeps its cause at the end (ODM, GDAL), so a long message keeps both ends.
	"""
	text = _UNSTORABLE.sub('�', redact_tokens(text))
	if max_chars is not None and len(text) > max_chars:
		keep = max(0, max_chars - len(_TRUNCATION_MARK))
		head = keep // 2
		text = text[:head] + _TRUNCATION_MARK + text[len(text) - (keep - head) :]
	return text
