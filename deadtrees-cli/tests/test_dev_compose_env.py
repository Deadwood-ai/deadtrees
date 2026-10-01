import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deadtrees_cli.dev import DevCommands


class DevComposeEnvTest(unittest.TestCase):
	def _isolated_env_file(self, tmp: str) -> Path:
		env_file = Path(tmp) / 'current.env'
		env_file.write_text('COMPOSE_PROJECT_NAME=deadtrees-test-dt-abc\nSUPABASE_URL=http://127.0.0.1:62821\n')
		return env_file

	def test_refuses_unsourced_isolated_env(self):
		with tempfile.TemporaryDirectory() as tmp:
			env_file = self._isolated_env_file(tmp)
			# The repo .env names the isolated project, but the database target is still shared.
			with patch.dict(
				os.environ,
				{
					'DEADTREES_ISOLATED_ENV_FILE': str(env_file),
					'COMPOSE_PROJECT_NAME': 'deadtrees-test-dt-abc',
					'SUPABASE_URL': 'http://127.0.0.1:54321',
				},
			):
				with self.assertRaises(SystemExit) as raised:
					DevCommands()

		self.assertIn('deadtrees-test-dt-abc', str(raised.exception))

	def test_uses_sourced_isolated_project(self):
		with tempfile.TemporaryDirectory() as tmp:
			env_file = self._isolated_env_file(tmp)
			with patch.dict(
				os.environ,
				{
					'DEADTREES_ISOLATED_ENV_FILE': str(env_file),
					'COMPOSE_PROJECT_NAME': 'deadtrees-test-dt-abc',
					'SUPABASE_URL': 'http://127.0.0.1:62821',
				},
			):
				os.environ.pop('COMPOSE_FILE', None)
				commands = DevCommands()

		self.assertEqual(commands.compose_env['COMPOSE_PROJECT_NAME'], 'deadtrees-test-dt-abc')
		self.assertEqual(commands._compose_cmd('ps'), ['docker', 'compose', '-f', 'docker-compose.test.yaml', 'ps'])

	def test_compose_file_override_replaces_default_file(self):
		with patch.dict(os.environ, {'COMPOSE_FILE': 'docker-compose.test.yaml:docker-compose.test.cpu.yaml'}):
			os.environ.pop('DEADTREES_ISOLATED_ENV_FILE', None)
			with patch('deadtrees_cli.dev.ISOLATED_ENV_FILE', Path('/nonexistent/current.env')):
				commands = DevCommands()

		self.assertEqual(commands._compose_cmd('ps'), ['docker', 'compose', 'ps'])
