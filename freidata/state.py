from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict


STATE_FILENAME = ".freidata_state.json"


def state_path(folder: Path) -> Path:
	return folder / STATE_FILENAME


def load_state(folder: Path) -> Dict[str, Any]:
	p = state_path(folder)
	if not p.exists():
		return {}
	try:
		return json.loads(p.read_text(encoding="utf-8"))
	except Exception:
		return {}


def save_state(folder: Path, state: Dict[str, Any]) -> None:
	p = state_path(folder)
	p.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
