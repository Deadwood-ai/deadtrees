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
