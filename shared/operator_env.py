from __future__ import annotations

import os
from pathlib import Path
from string import Template


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
		env[key.strip()] = Template(value).safe_substitute({**env, **os.environ})
	return env
