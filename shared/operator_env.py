from __future__ import annotations

import os
import re
from pathlib import Path


ENV_REFERENCE = re.compile(r'(?<!\$)\$(?:\{(?P<braced>[A-Za-z_][A-Za-z0-9_]*)\}|(?P<plain>[A-Za-z_][A-Za-z0-9_]*))')


def _expand_references(value: str, variables: dict[str, str]) -> str:
	def replace(match: re.Match[str]) -> str:
		name = match.group('braced') or match.group('plain')
		return variables.get(name, match.group(0))

	return ENV_REFERENCE.sub(replace, value)


def load_env_file(path: Path) -> dict[str, str]:
	env: dict[str, str] = {}
	if not path.exists():
		return env

	for raw_line in path.read_text().splitlines():
		line = raw_line.strip()
		if not line or line.startswith('#') or '=' not in line:
			continue
		key, value = line.split('=', 1)
		value = value.strip()
		if value and value[0] == value[-1] and value[0] in {'"', "'"}:
			value = value[1:-1]
		env[key.strip()] = _expand_references(value, {**env, **os.environ})
	return env
