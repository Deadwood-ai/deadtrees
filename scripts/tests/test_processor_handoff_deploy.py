import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).parents[1]
HANDOFF_SCRIPT = SCRIPTS / "processor_handoff_deploy.sh"


def run(*args: str, cwd: Path, env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
	return subprocess.run(args, cwd=cwd, check=check, text=True, capture_output=True, env=env)


def git(repo: Path, *args: str) -> str:
	return run("git", *args, cwd=repo).stdout.strip()


def make_executable(path: Path, body: str) -> None:
	path.write_text(body)
	path.chmod(path.stat().st_mode | stat.S_IEXEC)


class HandoffHarness:
	"""A processor checkout with fake Docker and a fake queue.

	The real runtime control tool manages the control files. Only the queue
	checks (wait-for-idle) and the asset preflight are faked. A slot's worker
	counts as idle once ``mark_idle`` created its marker.
	"""

	def __init__(self, tmp_path: Path):
		self.tmp_path = tmp_path
		self.origin = tmp_path / "origin.git"
		self.repo = tmp_path / "checkout"
		self.upstream = tmp_path / "upstream"
		self.bin_dir = tmp_path / "bin"
		self.docker_state = tmp_path / "docker-state"
		self.docker_log = tmp_path / "docker.log"
		self.docker_state.mkdir()

		run("git", "init", "--bare", "--initial-branch=main", str(self.origin), cwd=tmp_path)
		run("git", "clone", str(self.origin), str(self.upstream), cwd=tmp_path)
		git(self.upstream, "config", "user.name", "DeadTrees Tests")
		git(self.upstream, "config", "user.email", "tests@deadtrees.example")
		(self.upstream / "scripts" / "lib").mkdir(parents=True)
		(self.upstream / "shared").mkdir()
		for name in ("processor_handoff_deploy.sh", "processor_auto_deploy.sh", "processor_runtime_control.py"):
			shutil.copy2(SCRIPTS / name, self.upstream / "scripts" / name)
		shutil.copy2(SCRIPTS / "lib" / "processor_runtime.sh", self.upstream / "scripts" / "lib" / "processor_runtime.sh")
		shutil.copy2(SCRIPTS.parent / "shared" / "operator_env.py", self.upstream / "shared" / "operator_env.py")
		(self.upstream / "docker-compose.processor.yaml").write_text("services: {}\n")
		(self.upstream / ".gitignore").write_text("/.local\n.env\n__pycache__/\n")
		git(self.upstream, "add", ".")
		git(self.upstream, "commit", "-m", "initial")
		git(self.upstream, "push", "-u", "origin", "main")
		run("git", "clone", str(self.origin), str(self.repo), cwd=tmp_path)
		(self.repo / ".env").write_text("PROCESSOR_MEMORY_LIMIT=96G\nPROCESSOR_HANDOFF_MEMORY_LIMIT=24G\n")

		self.initial_sha = git(self.repo, "rev-parse", "HEAD")
		(self.repo / ".local").mkdir()
		(self.repo / ".local" / "processor-activated-sha").write_text(f"{self.initial_sha}\n")
		# The legacy single worker runs in slot a, the default Compose project.
		(self.docker_state / "default").write_text("memory=96G\n")

		self.bin_dir.mkdir()
		make_executable(
			self.bin_dir / "python3",
			"#!/bin/sh\n"
			"case \"$*\" in\n"
			"  *processor_asset_preflight.py*) exit \"${PROCESSOR_TEST_PREFLIGHT_RC:-0}\" ;;\n"
			"  *' status'*) echo '{}'; exit 0 ;;\n"
			"  *wait-for-idle*expected-release-sha*) exit \"${PROCESSOR_TEST_STARTUP_WAIT_RC:-0}\" ;;\n"
			f"  *wait-for-idle*) if [ -e {tmp_path}/idle-\"$PROCESSOR_WORKER_ID\" ]; then exit 0; fi; exit 4 ;;\n"
			"esac\n"
			f"exec {sys.executable} \"$@\"\n",
		)
		make_executable(self.bin_dir / "flock", "#!/bin/sh\nexit 0\n")
		make_executable(
			self.bin_dir / "docker",
			"#!/bin/sh\n"
			f"echo \"$*\" >> {self.docker_log}\n"
			f"state={self.docker_state}\n"
			"if [ \"$1\" = compose ]; then\n"
			"  shift\n"
			"  project=default\n"
			"  if [ \"$1\" = -p ]; then project=\"$2\"; shift 2; fi\n"
			"  case \"$*\" in\n"
			"    *' ps '*) if [ -e \"$state/$project\" ]; then echo \"cid-$project\"; fi ;;\n"
			"    *' build '*) if [ -n \"${PROCESSOR_TEST_BUILD_FAIL:-}\" ]; then exit 1; fi ;;\n"
			"    *' up '*) printf 'memory=%s\\nrelease=%s\\n' \"$PROCESSOR_MEMORY_LIMIT\" \"$PROCESSOR_RELEASE_SHA\" > \"$state/$project\" ;;\n"
			"    *' rm '*) rm -f \"$state/$project\" ;;\n"
			"  esac\n"
			"  exit 0\n"
			"fi\n"
			"if [ \"$1\" = update ]; then\n"
			"  for last; do :; done\n"
			"  sed -i \"s/^memory=.*/memory=$3/\" \"$state/${last#cid-}\"\n"
			"  exit 0\n"
			"fi\n"
			"if [ \"$1\" = inspect ]; then\n"
			"  case \"$*\" in\n"
			"    *Mounts*) if [ -n \"${PROCESSOR_TEST_BIND_MOUNT:-}\" ]; then echo bind; fi ;;\n"
			"    *RestartCount*) echo 'running false 0 0' ;;\n"
			"    *) echo 'running false' ;;\n"
			"  esac\n"
			"  exit 0\n"
			"fi\n"
			"exit 0\n",
		)
		self.env = os.environ.copy()
		self.env["PATH"] = f"{self.bin_dir}:{self.env['PATH']}"
		self.env["PROCESSOR_WORKER_ID"] = "host-test"
		self.env["PROCESSOR_READINESS_POLL_SECONDS"] = "0"
		self.env["PROCESSOR_STARTUP_TIMEOUT_SECONDS"] = "2"

	def release(self, message: str) -> str:
		(self.upstream / "README.md").write_text(f"{message}\n")
		git(self.upstream, "add", "README.md")
		git(self.upstream, "commit", "-m", message)
		git(self.upstream, "push", "origin", "main")
		return git(self.upstream, "rev-parse", "HEAD")

	def deploy(self, *args: str, script: str = "processor_handoff_deploy.sh", **env: str) -> subprocess.CompletedProcess[str]:
		return run(str(self.repo / "scripts" / script), *args, cwd=self.repo, env={**self.env, **env}, check=False)

	def mark_idle(self, worker_id: str) -> None:
		(self.tmp_path / f"idle-{worker_id}").touch()

	def container(self, project: str) -> dict[str, str] | None:
		path = self.docker_state / project
		if not path.exists():
			return None
		return dict(line.split("=", 1) for line in path.read_text().splitlines())

	def control(self, slot: str, name: str) -> dict | None:
		directory = "processor-control" if slot == "a" else f"processor-control-{slot}"
		path = self.repo / ".local" / directory / name
		return json.loads(path.read_text()) if path.exists() else None

	def local(self, name: str) -> str | None:
		path = self.repo / ".local" / name
		return path.read_text().strip() if path.exists() else None

	def log(self) -> str:
		return (self.repo / "auto-deploy.log").read_text()


class ProcessorHandoffDeployTest(unittest.TestCase):
	def setUp(self) -> None:
		self._tmp = tempfile.TemporaryDirectory()
		self.harness = HandoffHarness(Path(self._tmp.name))

	def tearDown(self) -> None:
		self._tmp.cleanup()

	def test_unchanged_release_starts_nothing(self) -> None:
		result = self.harness.deploy()

		self.assertEqual(result.returncode, 0, result.stderr)
		self.assertIn("No changes", self.harness.log())
		self.assertIsNone(self.harness.container("checkout-b"))

	def test_new_release_starts_beside_a_busy_worker_and_takes_the_queue(self) -> None:
		target = self.harness.release("second")

		result = self.harness.deploy()

		self.assertEqual(result.returncode, 0, result.stderr)
		self.assertEqual(self.harness.container("checkout-b"), {"memory": "24G", "release": target})
		self.assertIsNotNone(self.harness.container("default"), "the busy worker keeps its task")
		self.assertEqual(self.harness.control("a", "drain-request.json")["reason"], f"auto-deploy handoff to {target}")
		self.assertIsNone(self.harness.control("b", "drain-request.json"))
		self.assertEqual(self.harness.control("b", "claim-limits.json")["task_blacklist"], ["odm_processing"])
		self.assertEqual(self.harness.local("processor-active-slot"), "b")
		self.assertEqual(self.harness.local("processor-activated-sha"), target)
		self.assertEqual(json.loads(self.harness.local("processor-activated-worker-id-b"))["worker_id"], "host-test-b")

	def test_finished_worker_is_retired_and_the_new_slot_gets_the_full_budget(self) -> None:
		self.harness.release("second")
		self.harness.deploy()
		self.harness.mark_idle("host-test")

		result = self.harness.deploy()

		self.assertEqual(result.returncode, 0, result.stderr)
		self.assertIsNone(self.harness.container("default"))
		self.assertIsNone(self.harness.control("a", "drain-request.json"))
		self.assertIsNone(self.harness.control("b", "claim-limits.json"))
		self.assertEqual(self.harness.container("checkout-b")["memory"], "96G")
		self.assertIn("No changes", self.harness.log())

	def test_next_release_returns_to_slot_a_once_slot_b_is_free(self) -> None:
		self.harness.release("second")
		self.harness.deploy()
		self.harness.mark_idle("host-test")
		third = self.harness.release("third")

		result = self.harness.deploy()

		self.assertEqual(result.returncode, 0, result.stderr)
		self.assertEqual(self.harness.container("default"), {"memory": "24G", "release": third})
		self.assertEqual(self.harness.control("b", "drain-request.json")["reason"], f"auto-deploy handoff to {third}")
		self.assertEqual(self.harness.local("processor-active-slot"), "a")

	def test_release_waits_while_the_previous_release_is_still_finishing(self) -> None:
		second = self.harness.release("second")
		self.harness.deploy()
		self.harness.release("third")

		result = self.harness.deploy()

		self.assertEqual(result.returncode, 0, result.stderr)
		self.assertIn("slot a is still finishing a task", self.harness.log())
		self.assertEqual(self.harness.container("checkout-b")["release"], second)
		self.assertEqual(self.harness.local("processor-activated-sha"), second)

	def test_failed_build_removes_the_new_slot_and_leaves_the_old_worker_claiming(self) -> None:
		self.harness.release("second")

		result = self.harness.deploy(PROCESSOR_TEST_BUILD_FAIL="1")

		self.assertNotEqual(result.returncode, 0)
		self.assertIsNone(self.harness.container("checkout-b"))
		self.assertIsNone(self.harness.control("a", "drain-request.json"))
		self.assertIsNone(self.harness.control("b", "drain-request.json"))
		self.assertIsNone(self.harness.local("processor-active-slot"))
		self.assertEqual(self.harness.local("processor-activated-sha"), self.harness.initial_sha)
		self.assertIsNotNone(self.harness.local("processor-deploy-paused"))
		self.assertIn("Skipping deploy because automatic processor deploy is paused", self._deploy_log_after())

	def test_new_release_that_never_becomes_ready_is_removed(self) -> None:
		self.harness.release("second")

		result = self.harness.deploy(PROCESSOR_TEST_STARTUP_WAIT_RC="1")

		self.assertNotEqual(result.returncode, 0)
		self.assertIsNone(self.harness.container("checkout-b"))
		self.assertIsNone(self.harness.control("a", "drain-request.json"))
		self.assertIsNotNone(self.harness.local("processor-deploy-paused"))

	def test_operator_drain_on_the_active_slot_holds_the_release(self) -> None:
		self.harness.release("second")
		run(
			"python3", "scripts/processor_runtime_control.py", "set-drain", "--reason", "operator",
			cwd=self.harness.repo, env=self.harness.env,
		)

		result = self.harness.deploy()

		self.assertEqual(result.returncode, 0, result.stderr)
		self.assertIn("has a drain request", self.harness.log())
		self.assertIsNone(self.harness.container("checkout-b"))

	def test_refuses_while_the_active_worker_still_bind_mounts_its_code(self) -> None:
		self.harness.release("second")

		result = self.harness.deploy(PROCESSOR_TEST_BIND_MOUNT="1")

		self.assertNotEqual(result.returncode, 0)
		self.assertIn("still bind-mounts its code", self.harness.log())
		self.assertIsNone(self.harness.container("checkout-b"))

	def test_refuses_without_a_handoff_memory_limit(self) -> None:
		(self.harness.repo / ".env").write_text("PROCESSOR_MEMORY_LIMIT=96G\n")
		self.harness.release("second")

		result = self.harness.deploy()

		self.assertNotEqual(result.returncode, 0)
		self.assertIn("PROCESSOR_HANDOFF_MEMORY_LIMIT is not set", self.harness.log())
		self.assertIsNone(self.harness.container("checkout-b"))

	def test_drain_deploy_refuses_on_a_handoff_host(self) -> None:
		self.harness.release("second")
		self.harness.deploy()
		self.harness.release("third")

		result = self.harness.deploy(script="processor_auto_deploy.sh")

		self.assertNotEqual(result.returncode, 0)
		self.assertIn("run processor_handoff_deploy.sh", self.harness.log())

	def _deploy_log_after(self) -> str:
		self.harness.deploy()
		return self.harness.log()


if __name__ == "__main__":
	unittest.main()
