import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


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
		(self.repo / "docker-compose.processor.yaml").write_text("services: {}\n")
		shutil.copy2(SCRIPT, self.repo / "scripts" / "processor_docker_maintenance.sh")
		shutil.copy2(SCRIPT.parent / "lib" / "processor_runtime.sh", self.repo / "scripts" / "lib" / "processor_runtime.sh")
		(self.repo / "scripts" / "processor_runtime_control.py").write_text("# test stub\n")
		run("git", "init", "--initial-branch=main", cwd=self.repo)
		run("git", "config", "user.name", "DeadTrees Tests", cwd=self.repo)
		run("git", "config", "user.email", "tests@deadtrees.example", cwd=self.repo)
		run("git", "add", ".", cwd=self.repo)
		run("git", "commit", "-m", "initial", cwd=self.repo)

		self.bin_dir.mkdir()
		make_executable(self.bin_dir / "flock", "#!/bin/sh\nexit 0\n")
		make_executable(self.bin_dir / "sudo", f"#!/bin/sh\necho \"$@\" >> {self.sudo_log}\n[ \"$1\" = -n ] && shift\nexec \"$@\"\n")
		make_executable(
			self.bin_dir / "python3",
			f"#!/bin/sh\necho \"$@\" >> {self.python_log}\n"
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
			script = SNAP_CONTROL_SCRIPT.read_text()
			self.assertIn('exec /usr/bin/snap refresh --hold="${duration}" docker', script)
			self.assertIn('exec /usr/bin/snap refresh docker', script)

	def test_renew_hold_only_ignores_dirty_checkout(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = MaintenanceHarness(Path(tmp_dir), processor_available=True)
			(harness.repo / "docker-compose.processor.yaml").write_text("dirty\n")

			result = harness.run("--renew-hold-only")

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertIn("hold 7d", harness.snap_log.read_text())
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

	def test_maintenance_uses_noninteractive_trusted_snap_helper(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = MaintenanceHarness(Path(tmp_dir), processor_available=True)

			result = harness.run("--renew-hold-only")

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertIn(f"-n {harness.bin_dir / 'snap-control'} hold 7d", harness.sudo_log.read_text())

	def test_hold_renewal_creates_runtime_lock(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = MaintenanceHarness(Path(tmp_dir), processor_available=True)

			result = harness.run("--renew-hold-only")

			self.assertEqual(result.returncode, 0, result.stderr)
			lock_mode = (harness.repo / ".local" / "locks" / "processor-runtime.lock").stat().st_mode
			self.assertEqual(stat.S_IMODE(lock_mode), 0o666)


if __name__ == "__main__":
	unittest.main()
