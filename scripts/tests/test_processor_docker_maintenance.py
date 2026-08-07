import itertools
import json
import math
import os
import shutil
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from shared.asset_manifest import (
	GEOPACKAGE_SPECS,
	PHENOLOGY_ARRAY_SPECS,
	processor_model_checkpoint_specs,
	required_processor_asset_directories,
	required_processor_asset_files,
)


SCRIPT = Path(__file__).parents[1] / "processor_docker_maintenance.sh"
SNAP_CONTROL_SCRIPT = Path(__file__).parents[1] / "processor_snap_control.sh"


def run(*args: str, cwd: Path, check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
	return subprocess.run(args, cwd=cwd, check=check, text=True, capture_output=True, env=env)


def make_executable(path: Path, body: str) -> None:
	path.write_text(body)
	path.chmod(path.stat().st_mode | stat.S_IEXEC)


class MaintenanceHarness:
	def __init__(self, tmp_path: Path, *, processor_available: bool):
		self.repo = tmp_path / "repo"
		self.bin_dir = tmp_path / "bin"
		self.control_dir = tmp_path / "control"
		self.python_log = tmp_path / "python.log"
		self.docker_log = tmp_path / "docker.log"
		self.snap_log = tmp_path / "snap.log"
		self.sudo_log = tmp_path / "sudo.log"
		self.docker_running = tmp_path / "docker-running"
		self.repo.mkdir()
		(self.repo / "scripts").mkdir()
		(self.repo / "scripts" / "lib").mkdir()
		(self.repo / "shared").mkdir()
		(self.repo / "docker-compose.processor.yaml").write_text("services: {}\n")
		(self.repo / ".gitignore").write_text("/.local\n/assets\n__pycache__/\n")
		shutil.copy2(SCRIPT, self.repo / "scripts" / "processor_docker_maintenance.sh")
		shutil.copy2(SCRIPT.parent / "lib" / "processor_runtime.sh", self.repo / "scripts" / "lib" / "processor_runtime.sh")
		shutil.copy2(SCRIPT.parent / "processor_runtime_control.py", self.repo / "scripts" / "processor_runtime_control.py")
		shutil.copy2(SCRIPT.parent / "processor_asset_preflight.py", self.repo / "scripts" / "processor_asset_preflight.py")
		shutil.copy2(SCRIPT.parents[1] / "shared" / "operator_env.py", self.repo / "shared" / "operator_env.py")
		shutil.copy2(SCRIPT.parents[1] / "shared" / "asset_manifest.py", self.repo / "shared" / "asset_manifest.py")
		run("git", "init", "--initial-branch=main", cwd=self.repo)
		run("git", "config", "user.name", "DeadTrees Tests", cwd=self.repo)
		run("git", "config", "user.email", "tests@deadtrees.example", cwd=self.repo)
		run("git", "add", ".", cwd=self.repo)
		run("git", "commit", "-m", "initial", cwd=self.repo)
		(self.repo / ".local").mkdir()
		activated_sha = run("git", "rev-parse", "HEAD", cwd=self.repo).stdout.strip()
		(self.repo / ".local" / "processor-activated-sha").write_text(f"{activated_sha}\n")
		self._write_asset_fixtures()

		self.bin_dir.mkdir()
		make_executable(self.bin_dir / "flock", "#!/bin/sh\nexit 0\n")
		make_executable(
			self.bin_dir / "sudo",
			f"#!{sys.executable}\n"
			"import os\n"
			"import sys\n"
			f"with open({str(self.sudo_log)!r}, 'a') as log:\n"
			"    log.write(' '.join(sys.argv[1:]) + '\\n')\n"
			"args = sys.argv[1:]\n"
			"if args and args[0] == '-n':\n"
			"    args = args[1:]\n"
			"os.execv(args[0], args)\n",
		)
		make_executable(
			self.bin_dir / "python3",
			f"#!/bin/sh\necho \"$@\" >> {self.python_log}\n"
			f"if echo \"$@\" | grep -q processor_asset_preflight.py; then exec {sys.executable} \"$@\"; fi\n"
			"if echo \"$@\" | grep -q clear-ack && [ -n \"${PROCESSOR_TEST_ACK_PATH:-}\" ]; then\n"
			"  rm -f \"$PROCESSOR_TEST_ACK_PATH\"\n"
			"fi\n"
			"exit 0\n",
		)
		make_executable(self.bin_dir / "snap-control", f"#!/bin/sh\necho \"$@\" >> {self.snap_log}\nexit 0\n")
		make_executable(
			self.bin_dir / "docker",
			"#!/bin/sh\n"
			f"echo \"$@\" >> {self.docker_log}\n"
			"if [ \"$1\" = compose ] && echo \"$@\" | grep -q ' ps -q processor'; then\n"
			f"  if [ -e {self.docker_running} ]; then echo processor-container-id; fi\n"
			"  exit 0\n"
			"fi\n"
			"if [ \"$1\" = inspect ]; then\n"
			f"  if [ -e {self.docker_running} ]; then\n"
			"    case \"$*\" in *RestartCount*) echo 'running false 0 0' ;; *) echo 'running false' ;; esac\n"
			"    exit 0\n"
			"  fi\n"
			"  exit 1\n"
			"fi\n"
			"if [ \"$1\" = compose ] && echo \"$@\" | grep -q ' up '; then\n"
			f"  touch {self.docker_running}\n"
			"fi\n"
			"exit 0\n",
		)
		if processor_available:
			self.docker_running.touch()

		self.env = os.environ.copy()
		self.env["PATH"] = f"{self.bin_dir}:{self.env['PATH']}"
		self.env["PROCESSOR_DRAIN_REQUEST_PATH"] = str(self.control_dir / "drain-request.json")
		self.env["PROCESSOR_DRAIN_ACK_PATH"] = str(self.control_dir / "drain-ack.json")
		self.env["PROCESSOR_DRAIN_POLL_SECONDS"] = "0"
		self.env["PROCESSOR_UNAVAILABLE_POLL_SECONDS"] = "0"
		self.env["PROCESSOR_READINESS_POLL_SECONDS"] = "0"
		self.env["PROCESSOR_STARTUP_TIMEOUT_SECONDS"] = "2"
		self.env["PROCESSOR_SNAP_CONTROL"] = str(self.bin_dir / "snap-control")

	def _write_asset_fixtures(self) -> None:
		for relative in required_processor_asset_files():
			path = self.repo / "assets" / relative
			path.parent.mkdir(parents=True, exist_ok=True)
			if path.suffix == ".safetensors":
				minimum_tensors, required_tensors = processor_model_checkpoint_specs()[path.name]
				names = [*required_tensors, *(f"fixture.{index}" for index in range(minimum_tensors))]
				header = json.dumps(
					{name: {"dtype": "F32", "shape": [0], "data_offsets": [0, 0]} for name in names}
				).encode()
				path.write_bytes(struct.pack("<Q", len(header)) + header)
			elif path.suffix == ".gpkg":
				layer, required_columns = GEOPACKAGE_SPECS[relative]
				with closing(sqlite3.connect(path)) as database:
					with database:
						database.execute("CREATE TABLE gpkg_contents (table_name TEXT)")
						database.execute("INSERT INTO gpkg_contents VALUES (?)", (layer,))
						columns = ", ".join(f'"{column}" TEXT' for column in required_columns)
						database.execute(f'CREATE TABLE "{layer}" ({columns})')
			elif path.name == ".zarray":
				shape, chunks, _ = PHENOLOGY_ARRAY_SPECS[path.parent.name]
				path.write_text(json.dumps({"shape": shape, "chunks": chunks}))
			else:
				path.write_text("fixture\n")
		for relative in required_processor_asset_directories():
			array_dir = self.repo / "assets" / relative
			shape, chunks, omitted_chunks = PHENOLOGY_ARRAY_SPECS[array_dir.name]
			for coordinates in itertools.product(*(range(math.ceil(size / chunk)) for size, chunk in zip(shape, chunks))):
				path = array_dir / ".".join(map(str, coordinates))
				if path.name in omitted_chunks:
					continue
				path.parent.mkdir(parents=True, exist_ok=True)
				path.write_text("fixture\n")

	def run(self, *args: str) -> subprocess.CompletedProcess[str]:
		return run(
			"bash",
			"scripts/processor_docker_maintenance.sh",
			*args,
			cwd=self.repo,
			check=False,
			env=self.env,
		)


class ProcessorDockerMaintenanceTest(unittest.TestCase):
	def test_missing_assets_leave_worker_drained_without_restart(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = MaintenanceHarness(Path(tmp_dir), processor_available=True)
			(harness.repo / "assets" / "models" / "segformer_b5_full_epoch_100.safetensors").unlink()

			result = harness.run()

			self.assertNotEqual(result.returncode, 0)
			self.assertIn("set-drain --reason docker-maintenance", harness.python_log.read_text())
			self.assertIn(
				"set-drain --reason required processor assets missing --preserve-operator-drain",
				harness.python_log.read_text(),
			)
			docker_log = harness.docker_log.read_text()
			self.assertNotIn("stop processor", docker_log)
			self.assertNotIn("up -d processor", docker_log)

	def test_snap_control_limits_root_action_to_validated_docker_operations(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			tmp_path = Path(tmp_dir)
			invalid = run(
				"bash",
				str(SNAP_CONTROL_SCRIPT),
				"hold",
				"7d;touch /tmp/unsafe",
				cwd=tmp_path,
				check=False,
			)

			self.assertEqual(invalid.returncode, 2)
			self.assertIn("Hold duration", invalid.stderr)
			unsupported_days = run(
				"bash",
				str(SNAP_CONTROL_SCRIPT),
				"hold",
				"7d",
				cwd=tmp_path,
				check=False,
			)
			self.assertEqual(unsupported_days.returncode, 2)
			script = SNAP_CONTROL_SCRIPT.read_text()
			self.assertIn('exec /usr/bin/snap refresh --hold="${duration}" docker', script)
			self.assertIn('exec /usr/bin/snap refresh docker', script)

	def test_renew_hold_only_ignores_dirty_checkout(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = MaintenanceHarness(Path(tmp_dir), processor_available=True)
			(harness.repo / "docker-compose.processor.yaml").write_text("dirty\n")

			result = harness.run("--renew-hold-only")

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertIn("hold 168h", harness.snap_log.read_text())
			self.assertFalse(harness.python_log.exists())

	def test_unavailable_worker_uses_verified_recovery_before_maintenance(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = MaintenanceHarness(Path(tmp_dir), processor_available=False)

			result = harness.run()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertIn("stop processor", harness.docker_log.read_text())
			self.assertIn(
				"wait-for-idle --allow-unacknowledged-stopped-worker",
				harness.python_log.read_text(),
			)
			self.assertIn("record-worker-id", harness.python_log.read_text())

	def test_full_maintenance_rejects_checkout_not_matching_activated_sha(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = MaintenanceHarness(Path(tmp_dir), processor_available=True)
			(harness.repo / ".local" / "processor-activated-sha").write_text("older-activated-sha\n")

			result = harness.run()

			self.assertNotEqual(result.returncode, 0)
			self.assertFalse(harness.python_log.exists())
			self.assertEqual(harness.snap_log.read_text().splitlines(), ["hold 168h"])
			self.assertIn("does not match activated SHA", (harness.repo / "processor-maintenance.log").read_text())

	def test_maintenance_uses_noninteractive_trusted_snap_helper(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = MaintenanceHarness(Path(tmp_dir), processor_available=True)

			result = harness.run("--renew-hold-only")

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertIn(f"-n {harness.bin_dir / 'snap-control'} hold 168h", harness.sudo_log.read_text())

	def test_hold_renewal_creates_runtime_lock(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = MaintenanceHarness(Path(tmp_dir), processor_available=True)

			result = harness.run("--renew-hold-only")

			self.assertEqual(result.returncode, 0, result.stderr)
			lock_mode = (harness.repo / ".local" / "locks" / "processor-runtime.lock").stat().st_mode
			self.assertEqual(stat.S_IMODE(lock_mode), 0o666)


if __name__ == "__main__":
	unittest.main()
