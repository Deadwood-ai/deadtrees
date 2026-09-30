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
