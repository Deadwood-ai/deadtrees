#!/usr/bin/env python3
import subprocess
import time
from pathlib import Path
from typing import Optional, List
import fire


class DeadwoodTool:
	"""CLI tool for managing the Deadwood API development environment"""

	def __init__(self):
		self.test_compose_file = 'docker-compose.test.yaml'

	def _run_command(self, command: List[str], check: bool = True) -> subprocess.CompletedProcess:
		"""Run a shell command and handle errors"""
		try:
			return subprocess.run(command, check=check)
		except subprocess.CalledProcessError as e:
			print(f"Error executing command: {' '.join(command)}")
			print(f'Error: {str(e)}')
			raise

	def up(self):
		"""Start the test environment and rebuild containers if needed"""
		self._run_command(['docker', 'compose', '-f', self.test_compose_file, 'up', '-d', '--build'])

	def down(self):
		"""Stop the test environment"""
		self._run_command(['docker', 'compose', '-f', self.test_compose_file, 'down'])

	def debug(self, service: str = 'api-test', test_path: Optional[str] = None, port: Optional[int] = None):
		"""
		Start a debug session for tests

		Args:
		    service: Service to debug (api-test or processor-test)
		    test_path: Specific test file or directory to run
		    port: Debug port (default: 5679 for api-test, 5678 for processor-test)
		"""
		# Set default port based on service
		if port is None:
			port = 5679 if service == 'api-test' else 5678

		# Build the pytest command with test_path at the end
		cmd = [
			'docker',
			'compose',
			'-f',
			self.test_compose_file,
			'exec',
			service,  # Service name comes here
			'python',
			'-m',
			'debugpy',
			'--listen',
			f'0.0.0.0:{port}',
			'--wait-for-client',
			'-m',
			'pytest',
			'-v',
		]

		# Add test path if specified (after the pytest command)
		if test_path:
			cmd.append(test_path)  # Test path goes at the end of the command

		print(f'Starting debug session on port {port}')
		print('Waiting for debugger to attach...')
		self._run_command(cmd)

	def test(self, service: str = 'api-test', test_path: Optional[str] = None):
		"""
		Run tests without debugging

		Args:
			service: Service to test (api-test or processor-test)
			test_path: Specific test file or directory to run
		"""
		# Build the pytest command
		cmd = [
			'docker',
			'compose',
			'-f',
			self.test_compose_file,
			'exec',
			service,
			'python',
			'-m',
			'pytest',
			'-v',
		]

		# Add test path if specified
		if test_path:
			cmd.append(test_path)

		print(f'Running tests for {service}...')
		self._run_command(cmd)


if __name__ == '__main__':
	fire.Fire(DeadwoodTool)
