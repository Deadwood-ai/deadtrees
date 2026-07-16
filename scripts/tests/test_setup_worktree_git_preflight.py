import shutil
import subprocess
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "setup-worktree.sh"


def run(*args: str, cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
	return subprocess.run(
		args,
		cwd=cwd,
		check=check,
		text=True,
		capture_output=True,
	)


def git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
	return run("git", *args, cwd=repo)


def test_git_preflight_fetches_origin_and_rejects_a_stale_base(tmp_path: Path) -> None:
	origin = tmp_path / "origin.git"
	seed = tmp_path / "seed"
	worktree = tmp_path / "worktree"

	run("git", "init", "--bare", "--initial-branch=main", str(origin), cwd=tmp_path)
	run("git", "init", "--initial-branch=main", str(seed), cwd=tmp_path)
	git(seed, "config", "user.name", "DeadTrees Tests")
	git(seed, "config", "user.email", "tests@deadtrees.example")
	(seed / "README.md").write_text("initial\n")
	git(seed, "add", "README.md")
	git(seed, "commit", "-m", "initial")
	git(seed, "remote", "add", "origin", str(origin))
	git(seed, "push", "-u", "origin", "main")

	run("git", "clone", str(origin), str(worktree), cwd=tmp_path)
	(worktree / "scripts").mkdir()
	shutil.copy2(SCRIPT, worktree / "scripts" / "setup-worktree.sh")

	(seed / "README.md").write_text("initial\nnew remote work\n")
	git(seed, "add", "README.md")
	git(seed, "commit", "-m", "advance main")
	git(seed, "push", "origin", "main")
	remote_head = git(seed, "rev-parse", "HEAD").stdout.strip()

	result = run(
		"bash",
		"scripts/setup-worktree.sh",
		"--git-preflight-only",
		cwd=worktree,
		check=False,
	)

	assert result.returncode != 0
	assert "behind origin/main" in result.stderr
	assert git(worktree, "rev-parse", "origin/main").stdout.strip() == remote_head

	git(worktree, "merge", "--ff-only", "origin/main")
	result = run(
		"bash",
		"scripts/setup-worktree.sh",
		"--git-preflight-only",
		cwd=worktree,
	)

	assert "HEAD includes current origin/main" in result.stdout
