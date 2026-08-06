import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "processor_auto_deploy.sh"


def run(*args: str, cwd: Path, check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
	return subprocess.run(
		args,
		cwd=cwd,
		check=check,
		text=True,
		capture_output=True,
		env=env,
	)


def git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
	return run("git", *args, cwd=repo)


def make_executable(path: Path, body: str) -> None:
	path.write_text(body)
	path.chmod(path.stat().st_mode | stat.S_IEXEC)


class DeployHarness:
	def __init__(self, tmp_path: Path, *, processor_available: bool = True):
		self.tmp_path = tmp_path
		self.origin = tmp_path / "origin.git"
		self.seed = tmp_path / "seed"
		self.worktree = tmp_path / "worktree"
		self.upstream = tmp_path / "upstream"
		self.bin_dir = tmp_path / "bin"
		self.control_dir = tmp_path / "control"
		self.python_log = tmp_path / "python.log"
		self.docker_log = tmp_path / "docker.log"
		self.docker_running = tmp_path / "docker-running"
		self.wait_hook_marker = tmp_path / "wait-hook-ran"

		run("git", "init", "--bare", "--initial-branch=main", str(self.origin), cwd=tmp_path)
		run("git", "init", "--initial-branch=main", str(self.seed), cwd=tmp_path)
		git(self.seed, "config", "user.name", "DeadTrees Tests")
		git(self.seed, "config", "user.email", "tests@deadtrees.example")
		(self.seed / "scripts").mkdir()
		(self.seed / "README.md").write_text("initial\n")
		(self.seed / "docker-compose.processor.yaml").write_text("services: {}\n")
		shutil.copy2(SCRIPT, self.seed / "scripts" / "processor_auto_deploy.sh")
		(self.seed / "scripts" / "processor_runtime_control.py").write_text("# test stub\n")
		git(self.seed, "add", ".")
		git(self.seed, "commit", "-m", "initial")
		git(self.seed, "remote", "add", "origin", str(self.origin))
		git(self.seed, "push", "-u", "origin", "main")

		run("git", "clone", str(self.origin), str(self.worktree), cwd=tmp_path)
		run("git", "clone", str(self.origin), str(self.upstream), cwd=tmp_path)
		for repo in (self.worktree, self.upstream):
			git(repo, "config", "user.name", "DeadTrees Tests")
			git(repo, "config", "user.email", "tests@deadtrees.example")

		self.bin_dir.mkdir()
		make_executable(
			self.bin_dir / "python3",
			"#!/bin/sh\n"
			f"echo \"$@\" >> {self.python_log}\n"
			"if echo \"$@\" | grep -q wait-for-idle && "
			f"[ -n \"${{PROCESSOR_TEST_WAIT_HOOK:-}}\" ] && [ ! -e {self.wait_hook_marker} ]; then\n"
			f"  touch {self.wait_hook_marker}\n"
			"  sh \"$PROCESSOR_TEST_WAIT_HOOK\"\n"
			"fi\n"
			"exit 0\n",
		)
		make_executable(self.bin_dir / "flock", "#!/bin/sh\nexit 0\n")
		make_executable(
			self.bin_dir / "docker",
			"#!/bin/sh\n"
			f"echo \"$@\" >> {self.docker_log}\n"
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
		self.env["PROCESSOR_READINESS_POLL_SECONDS"] = "0"
		self.env["PROCESSOR_STARTUP_TIMEOUT_SECONDS"] = "2"

	def push_change(self, text: str) -> str:
		(self.upstream / "README.md").write_text(text)
		git(self.upstream, "add", "README.md")
		git(self.upstream, "commit", "-m", text.strip())
		git(self.upstream, "push", "origin", "main")
		return git(self.upstream, "rev-parse", "HEAD").stdout.strip()

	def run_deploy(self, *, wait_hook: Path | None = None) -> subprocess.CompletedProcess[str]:
		env = self.env.copy()
		if wait_hook is not None:
			env["PROCESSOR_TEST_WAIT_HOOK"] = str(wait_hook)
		return run(
			"bash",
			"scripts/processor_auto_deploy.sh",
			cwd=self.worktree,
			check=False,
			env=env,
		)


class ProcessorAutoDeployTest(unittest.TestCase):
	def test_rejects_local_ahead_checkout_before_drain(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			(harness.worktree / "README.md").write_text("initial\nlocal ahead work\n")
			git(harness.worktree, "add", "README.md")
			git(harness.worktree, "commit", "-m", "local ahead")

			result = harness.run_deploy()

			self.assertNotEqual(result.returncode, 0)
			self.assertFalse(harness.python_log.exists())
			self.assertIn(
				"Refusing deploy because HEAD contains local commits outside origin/main",
				(harness.worktree / "auto-deploy.log").read_text(),
			)

	def test_deploys_exact_fetched_sha_when_origin_advances_during_drain(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			selected_sha = harness.push_change("selected deploy\n")
			hook = harness.tmp_path / "advance-origin.sh"
			hook.write_text(
				f"cd {harness.upstream}\n"
				"printf 'later deploy\\n' > README.md\n"
				"git add README.md\n"
				"git commit -m 'later deploy'\n"
				"git push origin main\n"
			)

			first_result = harness.run_deploy(wait_hook=hook)

			self.assertEqual(first_result.returncode, 0, first_result.stderr)
			self.assertEqual(git(harness.worktree, "rev-parse", "HEAD").stdout.strip(), selected_sha)
			later_sha = git(harness.upstream, "rev-parse", "HEAD").stdout.strip()
			self.assertNotEqual(selected_sha, later_sha)

			second_result = harness.run_deploy()

			self.assertEqual(second_result.returncode, 0, second_result.stderr)
			self.assertEqual(git(harness.worktree, "rev-parse", "HEAD").stdout.strip(), later_sha)

	def test_recovery_deploy_stops_unavailable_worker_and_allows_missing_ack(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir), processor_available=False)
			harness.push_change("repair deploy\n")

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertIn("compose -f", harness.docker_log.read_text())
			self.assertIn("stop processor", harness.docker_log.read_text())
			self.assertIn(
				"wait-for-idle --allow-unacknowledged-stopped-worker",
				harness.python_log.read_text(),
			)

	def test_recovery_deploy_rechecks_worker_liveness_while_waiting_for_ack(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			harness.push_change("repair deploy\n")
			hook = harness.tmp_path / "crash-worker.sh"
			hook.write_text(f"rm -f {harness.docker_running}\nsleep 10\n")

			result = harness.run_deploy(wait_hook=hook)

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertIn("stop processor", harness.docker_log.read_text())
			self.assertIn(
				"wait-for-idle --allow-unacknowledged-stopped-worker",
				harness.python_log.read_text(),
			)
			self.assertIn(
				"Processor became unavailable while draining",
				(harness.worktree / "auto-deploy.log").read_text(),
			)
