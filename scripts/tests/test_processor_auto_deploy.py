import json
import os
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from shared.asset_manifest import (
	processor_model_checkpoint_specs,
	required_processor_asset_directories,
	required_processor_asset_files,
)


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
		self.inspect_failed_once = tmp_path / "inspect-failed-once"
		self.build_failed_once = tmp_path / "build-failed-once"
		self.activation_write_failed_once = tmp_path / "activation-write-failed-once"
		self.wait_hook_marker = tmp_path / "wait-hook-ran"
		self.waiter_fd_log = tmp_path / "waiter-fd.log"
		self.unhealthy_marker = self.control_dir / "loop-unhealthy.json"

		run("git", "init", "--bare", "--initial-branch=main", str(self.origin), cwd=tmp_path)
		run("git", "init", "--initial-branch=main", str(self.seed), cwd=tmp_path)
		git(self.seed, "config", "user.name", "DeadTrees Tests")
		git(self.seed, "config", "user.email", "tests@deadtrees.example")
		(self.seed / "scripts").mkdir()
		(self.seed / "scripts" / "lib").mkdir()
		(self.seed / "shared").mkdir()
		(self.seed / "README.md").write_text("initial\n")
		(self.seed / "docker-compose.processor.yaml").write_text("services: {}\n")
		(self.seed / ".gitignore").write_text("/.local\n/assets\n.env\n__pycache__/\n")
		shutil.copy2(SCRIPT, self.seed / "scripts" / "processor_auto_deploy.sh")
		shutil.copy2(SCRIPT.parent / "lib" / "processor_runtime.sh", self.seed / "scripts" / "lib" / "processor_runtime.sh")
		shutil.copy2(SCRIPT.parent / "processor_runtime_control.py", self.seed / "scripts" / "processor_runtime_control.py")
		shutil.copy2(SCRIPT.parent / "processor_asset_preflight.py", self.seed / "scripts" / "processor_asset_preflight.py")
		shutil.copy2(SCRIPT.parents[1] / "shared" / "operator_env.py", self.seed / "shared" / "operator_env.py")
		shutil.copy2(SCRIPT.parents[1] / "shared" / "asset_manifest.py", self.seed / "shared" / "asset_manifest.py")
		git(self.seed, "add", ".")
		git(self.seed, "commit", "-m", "initial")
		git(self.seed, "remote", "add", "origin", str(self.origin))
		git(self.seed, "push", "-u", "origin", "main")

		run("git", "clone", str(self.origin), str(self.worktree), cwd=tmp_path)
		run("git", "clone", str(self.origin), str(self.upstream), cwd=tmp_path)
		for repo in (self.worktree, self.upstream):
			git(repo, "config", "user.name", "DeadTrees Tests")
			git(repo, "config", "user.email", "tests@deadtrees.example")
			self._write_asset_fixtures(repo)

		self.bin_dir.mkdir()
		make_executable(
			self.bin_dir / "python3",
			"#!/bin/sh\n"
			f"echo \"$@\" >> {self.python_log}\n"
			f"if echo \"$@\" | grep -q processor_asset_preflight.py; then exec {sys.executable} \"$@\"; fi\n"
			"if echo \"$@\" | grep -q wait-for-idle; then\n"
			f"  if ( : <&9 ) 2>/dev/null; then echo \"inherited $*\" >> {self.waiter_fd_log}; else echo \"closed $*\" >> {self.waiter_fd_log}; fi\n"
			"fi\n"
			"if echo \"$@\" | grep -q wait-for-idle && "
			f"[ -n \"${{PROCESSOR_TEST_WAIT_HOOK:-}}\" ] && [ ! -e {self.wait_hook_marker} ]; then\n"
			f"  touch {self.wait_hook_marker}\n"
			"  sh \"$PROCESSOR_TEST_WAIT_HOOK\"\n"
			"fi\n"
			"if echo \"$@\" | grep -q clear-ack && [ -n \"${PROCESSOR_TEST_ACK_PATH:-}\" ]; then\n"
			"  rm -f \"$PROCESSOR_TEST_ACK_PATH\"\n"
			"fi\n"
			"if echo \"$@\" | grep -q 'set-drain.*--preserve-operator-drain' && "
			"[ -n \"${PROCESSOR_TEST_OPERATOR_DRAIN:-}\" ]; then\n"
			"  exit 3\n"
			"fi\n"
			"if echo \"$@\" | grep -q activation-ready; then\n"
			"  exit \"${PROCESSOR_TEST_ACTIVATION_READY:-1}\"\n"
			"fi\n"
			"if echo \"$@\" | grep -q asset-recovery-pending; then\n"
			"  exit \"${PROCESSOR_TEST_ASSET_RECOVERY_PENDING:-1}\"\n"
			"fi\n"
			"if echo \"$@\" | grep -q worker-health; then\n"
			"  if [ -e \"${PROCESSOR_TEST_UNHEALTHY_PATH:-}\" ]; then exit 1; fi\n"
			"  exit 0\n"
			"fi\n"
			"exit 0\n",
		)
		make_executable(self.bin_dir / "flock", "#!/bin/sh\nexit 0\n")
		make_executable(
			self.bin_dir / "mv",
			"#!/bin/sh\n"
			"target=''\n"
			"for arg in \"$@\"; do target=\"$arg\"; done\n"
			"if [ -n \"${PROCESSOR_TEST_ACTIVATION_WRITE_FAIL_ONCE:-}\" ] && "
			"echo \"$target\" | grep -q 'processor-activated-sha$' && "
			f"[ ! -e {self.activation_write_failed_once} ]; then\n"
			f"  touch {self.activation_write_failed_once}\n"
			"  exit 1\n"
			"fi\n"
			"exec /bin/mv \"$@\"\n",
		)
		make_executable(
			self.bin_dir / "docker",
			"#!/bin/sh\n"
			f"echo \"$@\" >> {self.docker_log}\n"
			"if [ \"$1\" = compose ] && echo \"$@\" | grep -q ' ps -q processor'; then\n"
			f"  if [ -e {self.docker_running} ]; then echo processor-container-id; fi\n"
			"  exit 0\n"
			"fi\n"
			"if [ \"$1\" = inspect ]; then\n"
			f"  if [ -n \"${{PROCESSOR_TEST_INSPECT_FAIL_ONCE:-}}\" ] && [ ! -e {self.inspect_failed_once} ]; then\n"
			f"    touch {self.inspect_failed_once}\n"
			"    exit 1\n"
			"  fi\n"
			f"  if [ -e {self.docker_running} ]; then\n"
			"    case \"$*\" in *RestartCount*) echo 'running false 0 0' ;; *) echo 'running false' ;; esac\n"
			"    exit 0\n"
			"  fi\n"
			"  exit 1\n"
			"fi\n"
			"if [ \"$1\" = compose ] && echo \"$@\" | grep -q ' up '; then\n"
			f"  touch {self.docker_running}\n"
			"fi\n"
			"if [ \"$1\" = compose ] && echo \"$@\" | grep -q ' build ' && "
			f"[ -n \"${{PROCESSOR_TEST_BUILD_FAIL_ONCE:-}}\" ] && [ ! -e {self.build_failed_once} ]; then\n"
			f"  touch {self.build_failed_once}\n"
			"  exit 1\n"
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
		self.env["PROCESSOR_TEST_UNHEALTHY_PATH"] = str(self.unhealthy_marker)

	@staticmethod
	def _write_asset_fixtures(repo: Path) -> None:
		for relative in required_processor_asset_files():
			path = repo / "assets" / relative
			path.parent.mkdir(parents=True, exist_ok=True)
			if path.suffix == ".safetensors":
				minimum_tensors, required_tensors = processor_model_checkpoint_specs()[path.name]
				names = [*required_tensors, *(f"fixture.{index}" for index in range(minimum_tensors))]
				header = json.dumps(
					{name: {"dtype": "F32", "shape": [0], "data_offsets": [0, 0]} for name in names}
				).encode()
				path.write_bytes(struct.pack("<Q", len(header)) + header)
			else:
				path.write_text("fixture\n")
		for relative in required_processor_asset_directories():
			path = repo / "assets" / relative / "0"
			path.parent.mkdir(parents=True, exist_ok=True)
			path.write_text("fixture\n")

	def push_change(self, text: str) -> str:
		(self.upstream / "README.md").write_text(text)
		git(self.upstream, "add", "README.md")
		git(self.upstream, "commit", "-m", text.strip())
		git(self.upstream, "push", "origin", "main")
		return git(self.upstream, "rev-parse", "HEAD").stdout.strip()

	def run_deploy(self, *script_args: str, wait_hook: Path | None = None) -> subprocess.CompletedProcess[str]:
		env = self.env.copy()
		if wait_hook is not None:
			env["PROCESSOR_TEST_WAIT_HOOK"] = str(wait_hook)
		return run(
			"bash",
			"scripts/processor_auto_deploy.sh",
			*script_args,
			cwd=self.worktree,
			check=False,
			env=env,
		)


class ProcessorAutoDeployTest(unittest.TestCase):
	def test_missing_assets_drains_and_pauses_before_docker_activation(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			(harness.worktree / "assets" / "models" / "segformer_b5_full_epoch_100.safetensors").unlink()

			result = harness.run_deploy()

			self.assertNotEqual(result.returncode, 0)
			self.assertTrue((harness.worktree / ".local" / "processor-deploy-paused").exists())
			self.assertIn("set-drain --reason required processor assets missing", harness.python_log.read_text())
			docker_log = harness.docker_log.read_text() if harness.docker_log.exists() else ""
			self.assertNotIn(" build ", docker_log)
			self.assertNotIn(" up ", docker_log)

	def test_external_assets_directory_passes_preflight(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			external_assets = harness.tmp_path / "shared-assets"
			shutil.copytree(harness.worktree / "assets", external_assets)
			shutil.rmtree(harness.worktree / "assets")
			harness.env["ASSET_ROOT"] = str(harness.tmp_path)
			(harness.worktree / ".env").write_text(
				"ASSET_ROOT=/stale/path\nPROCESSOR_ASSETS_DIR=${ASSET_ROOT}/shared-assets\n"
			)

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertIn(" build ", harness.docker_log.read_text())

	def test_external_assets_directory_expands_same_file_variable(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			external_assets = harness.tmp_path / "shared-assets"
			shutil.copytree(harness.worktree / "assets", external_assets)
			shutil.rmtree(harness.worktree / "assets")
			(harness.worktree / ".env").write_text(
				f"ASSET_ROOT={harness.tmp_path}\nPROCESSOR_ASSETS_DIR=${{ASSET_ROOT}}/shared-assets\n"
			)

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertIn(" build ", harness.docker_log.read_text())

	def test_target_release_can_remove_an_obsolete_asset_requirement(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			(harness.worktree / "assets" / "models" / "segformer_b5_full_epoch_100.safetensors").unlink()
			target_preflight = harness.upstream / "scripts" / "processor_asset_preflight.py"
			target_preflight.write_text("raise SystemExit(0)\n")
			git(harness.upstream, "add", "scripts/processor_asset_preflight.py")
			git(harness.upstream, "commit", "-m", "remove obsolete asset requirement")
			git(harness.upstream, "push", "origin", "main")

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertEqual(
				git(harness.worktree, "rev-parse", "HEAD").stdout.strip(),
				git(harness.upstream, "rev-parse", "HEAD").stdout.strip(),
			)

	def test_restored_assets_clear_asset_loss_drain_after_resume(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			self.assertEqual(harness.run_deploy().returncode, 0)
			model = harness.worktree / "assets" / "models" / "segformer_b5_full_epoch_100.safetensors"
			model_bytes = model.read_bytes()
			model.unlink()

			self.assertNotEqual(harness.run_deploy().returncode, 0)
			model.write_bytes(model_bytes)
			self.assertEqual(harness.run_deploy("--resume").returncode, 0)
			harness.env["PROCESSOR_TEST_ASSET_RECOVERY_PENDING"] = "0"

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertIn("asset-recovery-pending", harness.python_log.read_text())
			self.assertIn("clear-drain", harness.python_log.read_text())
			self.assertIn("up -d --force-recreate processor", harness.docker_log.read_text())

	def test_restored_assets_recover_when_worker_is_unavailable(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			self.assertEqual(harness.run_deploy().returncode, 0)
			model = harness.worktree / "assets" / "models" / "segformer_b5_full_epoch_100.safetensors"
			model_bytes = model.read_bytes()
			model.unlink()

			self.assertNotEqual(harness.run_deploy().returncode, 0)
			model.write_bytes(model_bytes)
			harness.docker_running.unlink()
			self.assertEqual(harness.run_deploy("--resume").returncode, 0)
			harness.env["PROCESSOR_TEST_ASSET_RECOVERY_PENDING"] = "0"

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertIn("wait-for-idle --allow-unacknowledged-stopped-worker", harness.python_log.read_text())
			self.assertIn("up -d --force-recreate processor", harness.docker_log.read_text())
			self.assertIn("clear-drain", harness.python_log.read_text())

	def test_restored_assets_preserve_planned_shutdown(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			self.assertEqual(harness.run_deploy().returncode, 0)
			harness.env["PROCESSOR_TEST_OPERATOR_DRAIN"] = "1"
			model = harness.worktree / "assets" / "models" / "segformer_b5_full_epoch_100.safetensors"
			model_bytes = model.read_bytes()
			model.unlink()
			harness.docker_running.unlink()
			up_count = harness.docker_log.read_text().count("up -d")
			clear_count = harness.python_log.read_text().count("clear-drain")

			self.assertNotEqual(harness.run_deploy().returncode, 0)
			model.write_bytes(model_bytes)
			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertEqual(harness.docker_log.read_text().count("up -d"), up_count)
			self.assertEqual(harness.python_log.read_text().count("clear-drain"), clear_count)
			self.assertFalse(harness.docker_running.exists())

	def test_target_release_runs_its_activation_logic_before_marking_active(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			activation_hook = harness.tmp_path / "target-activation-ran"
			target_script = harness.upstream / "scripts" / "processor_auto_deploy.sh"
			target_script.write_text(
				target_script.read_text().replace(
					'log "Deployment complete ($(git rev-parse --short HEAD))"',
					f'touch {activation_hook}\nlog "Deployment complete ($(git rev-parse --short HEAD))"',
				)
			)
			git(harness.upstream, "add", "scripts/processor_auto_deploy.sh")
			git(harness.upstream, "commit", "-m", "add target activation hook")
			git(harness.upstream, "push", "origin", "main")

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertTrue(activation_hook.exists())

	def test_no_change_run_completes_interrupted_activation(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			self.assertEqual(harness.run_deploy().returncode, 0)
			harness.env["PROCESSOR_TEST_ACTIVATION_READY"] = "0"
			before = harness.python_log.read_text().count("clear-drain")

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertEqual(harness.python_log.read_text().count("clear-drain"), before + 1)

	def test_activation_marker_failure_keeps_drain_and_pauses_deploy(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			harness.push_change("marker failure\n")
			harness.env["PROCESSOR_TEST_ACTIVATION_WRITE_FAIL_ONCE"] = "1"

			result = harness.run_deploy()

			self.assertNotEqual(result.returncode, 0)
			self.assertFalse((harness.worktree / ".local" / "processor-activated-sha").exists())
			self.assertTrue((harness.worktree / ".local" / "processor-deploy-paused").exists())
			self.assertNotIn("clear-drain", harness.python_log.read_text())

	def test_background_drain_waiter_does_not_inherit_runtime_lock(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			harness.push_change("lock-safe deploy\n")

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			observations = harness.waiter_fd_log.read_text().splitlines()
			self.assertTrue(observations[0].startswith("closed "), observations)
			self.assertIn("record-worker-id", harness.python_log.read_text())

	def test_rejects_local_ahead_checkout_before_drain(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			(harness.worktree / "README.md").write_text("initial\nlocal ahead work\n")
			git(harness.worktree, "add", "README.md")
			git(harness.worktree, "commit", "-m", "local ahead")

			result = harness.run_deploy()

			self.assertNotEqual(result.returncode, 0)
			python_log = harness.python_log.read_text() if harness.python_log.exists() else ""
			self.assertNotIn("set-drain", python_log)
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

	def test_recovery_deploy_stops_running_worker_with_persisted_loop_failure(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			harness.push_change("repair unhealthy loop\n")
			harness.control_dir.mkdir(parents=True)
			harness.unhealthy_marker.write_text('{"failure_count": 3}\n')

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
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

	def test_single_failed_inspect_does_not_stop_running_worker(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			harness.push_change("normal deploy\n")
			harness.env["PROCESSOR_TEST_INSPECT_FAIL_ONCE"] = "1"

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertNotIn("stop processor", harness.docker_log.read_text())
			self.assertIn("ps -q processor", harness.docker_log.read_text())
			self.assertNotIn("inspect deadtrees-processor-1", harness.docker_log.read_text())

	def test_custom_control_directory_ack_is_cleared_through_runtime_control(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			harness.push_change("custom paths\n")
			custom_ack = harness.tmp_path / "env-only-control" / "ack.json"
			custom_ack.parent.mkdir()
			custom_ack.write_text("stale\n")
			(harness.worktree / ".env").write_text(f"PROCESSOR_CONTROL_DIR={custom_ack.parent}\n")
			(harness.worktree / ".git" / "info" / "exclude").write_text(".env\n")
			harness.env.pop("PROCESSOR_DRAIN_REQUEST_PATH")
			harness.env.pop("PROCESSOR_DRAIN_ACK_PATH")
			harness.env["PROCESSOR_TEST_ACK_PATH"] = str(custom_ack)

			result = harness.run_deploy()

			self.assertEqual(result.returncode, 0, result.stderr)
			self.assertFalse(custom_ack.exists())
			self.assertIn("clear-ack", harness.python_log.read_text())

	def test_failed_deploy_requires_explicit_resume_before_retry(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			target_sha = harness.push_change("retry deploy\n")
			harness.env["PROCESSOR_TEST_BUILD_FAIL_ONCE"] = "1"

			first_result = harness.run_deploy()

			self.assertNotEqual(first_result.returncode, 0)
			self.assertEqual(git(harness.worktree, "rev-parse", "HEAD").stdout.strip(), target_sha)
			self.assertFalse((harness.worktree / ".local" / "processor-activated-sha").exists())
			self.assertTrue((harness.worktree / ".local" / "processor-deploy-paused").exists())

			second_result = harness.run_deploy()

			self.assertEqual(second_result.returncode, 0, second_result.stderr)
			self.assertFalse((harness.worktree / ".local" / "processor-activated-sha").exists())

			resume_result = harness.run_deploy("--resume")
			third_result = harness.run_deploy()

			self.assertEqual(resume_result.returncode, 0, resume_result.stderr)
			self.assertEqual(third_result.returncode, 0, third_result.stderr)
			self.assertFalse((harness.worktree / ".local" / "processor-deploy-paused").exists())
			self.assertEqual(
				(harness.worktree / ".local" / "processor-activated-sha").read_text().strip(),
				target_sha,
			)

	def test_paused_deploy_does_not_apply_new_remote_sha_until_resumed(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			harness = DeployHarness(Path(tmp_dir))
			activated_sha = git(harness.worktree, "rev-parse", "HEAD").stdout.strip()

			initial_result = harness.run_deploy()
			self.assertEqual(initial_result.returncode, 0, initial_result.stderr)
			self.assertEqual(
				(harness.worktree / ".local" / "processor-activated-sha").read_text().strip(),
				activated_sha,
			)

			harness.push_change("failed B\n")
			harness.env["PROCESSOR_TEST_BUILD_FAIL_ONCE"] = "1"
			self.assertNotEqual(harness.run_deploy().returncode, 0)

			new_target_sha = harness.push_change("fixed C\n")
			paused_result = harness.run_deploy()
			self.assertEqual(paused_result.returncode, 0, paused_result.stderr)
			self.assertNotEqual(git(harness.worktree, "rev-parse", "HEAD").stdout.strip(), new_target_sha)

			self.assertEqual(harness.run_deploy("--resume").returncode, 0)
			resumed_result = harness.run_deploy()
			self.assertEqual(resumed_result.returncode, 0, resumed_result.stderr)
			self.assertEqual(
				(harness.worktree / ".local" / "processor-activated-sha").read_text().strip(),
				new_target_sha,
			)
