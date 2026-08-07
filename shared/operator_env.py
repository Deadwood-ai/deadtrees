from __future__ import annotations

import os
import re
from pathlib import Path


ENV_REFERENCE = re.compile(
	r'(?<!\$)\$(?:\{(?P<braced>[A-Za-z_][A-Za-z0-9_]*)'
	r'(?:(?P<operator>:-|-|:\+|\+|:\?|\?)(?P<operand>[^{}]*))?\}|(?P<plain>[A-Za-z_][A-Za-z0-9_]*))'
)
DOUBLE_QUOTED_ESCAPES = {'n': '\n', 'r': '\r', 't': '\t', '\\': '\\', '"': '"'}


def _expand_references(value: str, variables: dict[str, str]) -> str:
	def replace(match: re.Match[str]) -> str:
		name = match.group('braced') or match.group('plain')
		operator = match.group('operator')
		operand = match.group('operand') or ''
		is_set = name in variables
		value = variables.get(name, '')
		is_nonempty = is_set and value != ''

		if operator is None:
			return value
		if operator == ':-':
			return value if is_nonempty else _expand_references(operand, variables)
		if operator == '-':
			return value if is_set else _expand_references(operand, variables)
		if operator == ':+':
			return _expand_references(operand, variables) if is_nonempty else ''
		if operator == '+':
			return _expand_references(operand, variables) if is_set else ''
		if operator == ':?' and not is_nonempty:
			raise ValueError(operand or f'{name} is required')
		if operator == '?' and not is_set:
			raise ValueError(operand or f'{name} is required')
		return value

	return ENV_REFERENCE.sub(replace, value)


def _parse_value(raw_value: str) -> tuple[str, bool]:
	value = raw_value.strip()
	if value.startswith(("'", '"')):
		quote = value[0]
		parsed = []
		escaped = False
		for character in value[1:]:
			if escaped:
				if quote == '"':
					parsed.append(DOUBLE_QUOTED_ESCAPES.get(character, f'\\{character}'))
				else:
					parsed.append("'" if character == "'" else f'\\{character}')
				escaped = False
			elif character == '\\':
				escaped = True
			elif character == quote:
				return ''.join(parsed), quote == "'"
			else:
				parsed.append(character)
		if escaped:
			parsed.append('\\')
		return value, False
	value = re.split(r'\s+#', value, maxsplit=1)[0].rstrip()
	return value, False


def load_env_file(path: Path) -> dict[str, str]:
	env: dict[str, str] = {}
	if not path.exists():
		return env

	for raw_line in path.read_text().splitlines():
		line = raw_line.strip()
		if not line or line.startswith('#') or '=' not in line:
			continue
		key, raw_value = line.split('=', 1)
		value, single_quoted = _parse_value(raw_value)
		env[key.strip()] = value if single_quoted else _expand_references(value, {**env, **os.environ})
	return env
