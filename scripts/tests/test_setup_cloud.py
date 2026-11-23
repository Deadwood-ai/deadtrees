import os
import shutil
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).parents[2]
SCRIPT = REPO_ROOT / "scripts" / "setup-cloud.sh"


def make_repo(tmp_path: Path) -> Path:
	repo = tmp_path / "repo"
	(repo / "scripts").mkdir(parents=True)
	(repo / "api").mkdir()
	(repo / "nginx" / "test-conf").mkdir(parents=True)
	shutil.copy2(SCRIPT, repo / "scripts" / "setup-cloud.sh")
	shutil.copy2(REPO_ROOT / "api" / "Dockerfile", repo / "api" / "Dockerfile")
	shutil.copy2(
		REPO_ROOT / "nginx" / "test-conf" / "storage-server.conf",
		repo / "nginx" / "test-conf" / "storage-server.conf",
	)
	return repo


def run_session(repo: Path, tmp_path: Path) -> list[str]:
	"""Run `session` with every tool stubbed; return the setup-worktree.sh calls."""
	stubs = tmp_path / "stubs"
	stubs.mkdir(exist_ok=True)
	for name in ("docker", "gdal_translate", "ssh-keygen", "supabase", "sudo", "pkill", "npm"):
		stub = stubs / name
		stub.write_text("#!/bin/sh\nexit 0\n")
		stub.chmod(0o755)
	# Never root, so the script's root steps go through the stubbed sudo.
	(stubs / "id").write_text("#!/bin/sh\necho 1000\n")
	(stubs / "id").chmod(0o755)
	calls = tmp_path / "calls"
	calls.write_text("")
	(repo / "scripts" / "setup-worktree.sh").write_text(
		f'mkdir -p "{repo}/venv/bin"\necho install >>"{calls}"\n'
		f'touch "{repo}/venv/bin/deadtrees"\nchmod +x "{repo}/venv/bin/deadtrees"\n'
	)
	subprocess.run(
		["bash", "scripts/setup-cloud.sh", "session"],
		cwd=repo,
		check=True,
		capture_output=True,
		env={
			**os.environ,
			"PATH": f"{stubs}:{os.environ['PATH']}",
			"DEADTREES_CLOUD_LOG_DIR": str(tmp_path / "logs"),
		},
	)
	return calls.read_text().split()


def test_session_reinstalls_the_venv_only_when_the_cli_dependencies_change(tmp_path: Path) -> None:
	repo = make_repo(tmp_path)
	setup_py = repo / "deadtrees-cli" / "setup.py"
	setup_py.parent.mkdir()
	setup_py.write_text("install_requires=['fire']\n")

	assert run_session(repo, tmp_path) == ["install"]
	assert run_session(repo, tmp_path) == []

	setup_py.write_text("install_requires=['fire', 'pillow']\n")
	assert run_session(repo, tmp_path) == ["install"]
	assert run_session(repo, tmp_path) == []


def compose_override(repo: Path, ca_bundle: Path) -> subprocess.CompletedProcess[str]:
	return subprocess.run(
		["bash", "scripts/setup-cloud.sh", "compose-override"],
		cwd=repo,
		check=True,
		text=True,
		capture_output=True,
		env={**os.environ, "DEADTREES_CLOUD_CA_BUNDLE": str(ca_bundle)},
	)


def test_compose_override_trusts_the_ca_in_every_build_stage(tmp_path: Path) -> None:
	repo = make_repo(tmp_path)
	ca_bundle = tmp_path / "ca.crt"
	ca_bundle.write_text("test bundle\n")

	result = compose_override(repo, ca_bundle)

	out_dir = repo / ".local" / "cloud"
	assert result.stdout.strip() == f"{repo}/docker-compose.test.yaml:{out_dir}/docker-compose.cloud.yaml"
	assert (out_dir / "ca-bundle.crt").read_text() == "test bundle\n"
	dockerfile = (out_dir / "api.Dockerfile").read_text().splitlines()
	from_lines = [i for i, line in enumerate(dockerfile) if line.startswith("FROM ")]
	assert from_lines
	for index in from_lines:
		assert dockerfile[index + 1].startswith("COPY --from=cloud_ca ca-bundle.crt ")
		assert "PIP_CERT=" in dockerfile[index + 2]
	override = (out_dir / "docker-compose.cloud.yaml").read_text()
	assert f"dockerfile: {out_dir}/api.Dockerfile" in override
	assert f"cloud_ca: {out_dir}" in override


def test_compose_override_drops_only_the_ipv6_nginx_listen(tmp_path: Path) -> None:
	repo = make_repo(tmp_path)
	ca_bundle = tmp_path / "ca.crt"
	ca_bundle.write_text("test bundle\n")

	compose_override(repo, ca_bundle)

	original = (repo / "nginx" / "test-conf" / "storage-server.conf").read_text().splitlines()
	generated = (repo / ".local" / "cloud" / "storage-server.conf").read_text().splitlines()
	assert [line for line in original if "listen [::]" not in line] == generated
	assert any("listen 80" in line for line in generated)


def test_compose_override_without_a_ca_bundle_keeps_the_test_compose_file(tmp_path: Path) -> None:
	repo = make_repo(tmp_path)

	result = compose_override(repo, tmp_path / "missing.crt")

	assert result.stdout.strip() == f"{repo}/docker-compose.test.yaml"
	assert not (repo / ".local" / "cloud").exists()
