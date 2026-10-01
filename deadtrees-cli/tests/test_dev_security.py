import io
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from deadtrees_cli.dev import DevCommands
from shared.settings import settings


class DevAccountOutputSecurityTest(unittest.TestCase):
	def test_dev_account_output_omits_passwords(self):
		passwords = ('primary-secret', 'secondary-secret', 'processor-secret')
		output = io.StringIO()

		with (
			patch.object(settings, 'TEST_USER_PASSWORD', passwords[0]),
			patch.object(settings, 'TEST_USER_PASSWORD2', passwords[1]),
			patch.object(settings, 'PROCESSOR_PASSWORD', passwords[2]),
			# Keep the test independent of a worktree's isolated stack.
			patch.dict('os.environ', {'DEADTREES_ISOLATED_ENV_FILE': ''}),
			patch('deadtrees_cli.dev.ISOLATED_ENV_FILE', Path('/nonexistent/current.env')),
			redirect_stdout(output),
		):
			DevCommands()._print_dev_accounts()

		printed = output.getvalue()
		self.assertIn(settings.TEST_USER_EMAIL, printed)
		self.assertIn(settings.TEST_USER_EMAIL2, printed)
		self.assertIn(settings.PROCESSOR_USERNAME, printed)
		self.assertTrue(all(password not in printed for password in passwords))
