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


class ProcessorAutoDeployTest(unittest.TestCase):
	def test_rejects_local_ahead_checkout_before_drain(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			tmp_path = Path(tmp_dir)
			origin = tmp_path / "origin.git"
			seed = tmp_path / "seed"
			worktree = tmp_path / "worktree"
			bin_dir = tmp_path / "bin"
			control_dir = tmp_path / "control"
			python_log = tmp_path / "python.log"

			run("git", "init", "--bare", "--initial-branch=main", str(origin), cwd=tmp_path)
			run("git", "init", "--initial-branch=main", str(seed), cwd=tmp_path)
			git(seed, "config", "user.name", "DeadTrees Tests")
			git(seed, "config", "user.email", "tests@deadtrees.example")
			(seed / "scripts").mkdir()
			(seed / "README.md").write_text("initial\n")
			shutil.copy2(SCRIPT, seed / "scripts" / "processor_auto_deploy.sh")
			git(seed, "add", "README.md")
			git(seed, "add", "scripts/processor_auto_deploy.sh")
			git(seed, "commit", "-m", "initial")
			git(seed, "remote", "add", "origin", str(origin))
			git(seed, "push", "-u", "origin", "main")

			run("git", "clone", str(origin), str(worktree), cwd=tmp_path)

			git(worktree, "config", "user.name", "DeadTrees Tests")
			git(worktree, "config", "user.email", "tests@deadtrees.example")
			(worktree / "README.md").write_text("initial\nlocal ahead work\n")
			git(worktree, "add", "README.md")
			git(worktree, "commit", "-m", "local ahead")

			bin_dir.mkdir()
			python_stub = bin_dir / "python3"
			python_stub.write_text(
				"#!/bin/sh\n"
				f"echo \"$@\" >> {python_log}\n"
				"exit 0\n"
			)
			python_stub.chmod(python_stub.stat().st_mode | stat.S_IEXEC)
			flock_stub = bin_dir / "flock"
			flock_stub.write_text(
				"#!/bin/sh\n"
				"exit 0\n"
			)
			flock_stub.chmod(flock_stub.stat().st_mode | stat.S_IEXEC)

			env = os.environ.copy()
			env["PATH"] = f"{bin_dir}:{env['PATH']}"
			env["PROCESSOR_DRAIN_REQUEST_PATH"] = str(control_dir / "drain-request.json")

			result = run(
				"bash",
				"scripts/processor_auto_deploy.sh",
				cwd=worktree,
				check=False,
				env=env,
			)

			self.assertNotEqual(result.returncode, 0)
			self.assertFalse(python_log.exists())
			self.assertIn(
				"Refusing deploy because HEAD contains local commits outside origin/main",
				(worktree / "auto-deploy.log").read_text(),
			)
