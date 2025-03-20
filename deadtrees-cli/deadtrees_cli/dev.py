import subprocess
import os
from typing import Optional, List
from datetime import datetime


class DevCommands:
	"""Development environment management commands"""

	def __init__(self):
		self.test_compose_file = 'docker-compose.test.yaml'

	def _run_command(self, command: List[str], check: bool = True) -> subprocess.CompletedProcess:
		"""Run a shell command and handle errors"""
		try:
			return subprocess.run(command, check=check)
		except subprocess.CalledProcessError as e:
			print(f'Error executing command: {" ".join(command)}')
			print(f'Error: {str(e)}')
			raise

	def _check_rebuild_needed(self) -> List[str]:
		"""Check which services need rebuilding by comparing image and dockerfile timestamps"""
		services_to_rebuild = []

		# Get list of all services
		result = subprocess.run(
			['docker', 'compose', '-f', self.test_compose_file, 'config', '--services'],
			capture_output=True,
			text=True,
			check=True,
		)
		services = result.stdout.strip().split('\n')

		for service in services:
			# Check if image exists
			result = subprocess.run(
				['docker', 'compose', '-f', self.test_compose_file, 'images', '-q', service],
				capture_output=True,
				text=True,
				check=False,
			)

			if not result.stdout.strip():
				services_to_rebuild.append(service)
				continue

			# Get Dockerfile timestamp if it exists
			dockerfile_path = f'./{service}/Dockerfile'
			if os.path.exists(dockerfile_path):
				dockerfile_mtime = os.path.getmtime(dockerfile_path)

				# Get image creation timestamp
				result = subprocess.run(
					['docker', 'inspect', '-f', '{{.Created}}', f'deadwood_network-{service}'],
					capture_output=True,
					text=True,
					check=False,
				)

				if result.returncode == 0:
					image_timestamp = datetime.fromisoformat(result.stdout.strip().replace('Z', '+00:00'))
					if dockerfile_mtime > image_timestamp.timestamp():
						services_to_rebuild.append(service)

		return services_to_rebuild

	def start(self, force_rebuild: bool = False):
		"""Start the test environment and rebuild containers if needed"""
		if force_rebuild:
			services_to_rebuild = ['--build']
		else:
			services_to_rebuild = self._check_rebuild_needed()
			if services_to_rebuild:
				print(f'Rebuilding services: {", ".join(services_to_rebuild)}')
				services_to_rebuild = ['--build'] + services_to_rebuild

		cmd = ['docker', 'compose', '-f', self.test_compose_file, 'up', '-d'] + services_to_rebuild
		self._run_command(cmd)

	def stop(self):
		"""Stop the test environment"""
		self._run_command(['docker', 'compose', '-f', self.test_compose_file, 'down'])

	def debug(self, service: str = 'api', test_path: Optional[str] = None, port: Optional[int] = None):
		"""
		Start a debug session for tests

		Args:
		    service: Service to debug (api-test or processor-test)
		    test_path: Specific test file or directory to run
		    port: Debug port (default: 5679 for api-test, 5678 for processor-test)
		"""
		# Set default port based on service
		if port is None:
			port = 5679 if service == 'api' else 5678
		if service == 'api':
			service = 'api-test'
		elif service == 'processor':
			service = 'processor-test'
		else:
			raise ValueError(f'Invalid service: {service}')

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

		if test_path:
			cmd.append(test_path)

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
		if service == 'api':
			service = 'api-test'
		elif service == 'processor':
			service = 'processor-test'
		else:
			raise ValueError(f'Invalid service: {service}')

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

		if test_path:
			cmd.append(test_path)

		print(f'Running tests for {service}...')
		self._run_command(cmd)

	def run_dev(self):
		"""Start complete test environment with continuous processor queue checking"""
		# Build and start all services
		self._run_command(['docker', 'compose', '-f', self.test_compose_file, 'up', '-d', '--build'])

		# Start the processor in continuous mode
		self._run_command(
			[
				'docker',
				'compose',
				'-f',
				self.test_compose_file,
				'exec',
				'processor-test',
				'python',
				# '-m',
				# 'debugpy',
				# '--listen',
				# '0.0.0.0:5678',
				'-m',
				'processor.src.continuous_processor',
			]
		)

	def debug_data(self, test_path: Optional[str] = None, port: int = 5680):
		"""
		Debug CLI tests

		Args:
		    test_path: Specific test file or directory to run
		    port: Debug port (default: 5680)
		"""
		cmd = [
			'python',
			'-m',
			'debugpy',
			'--listen',
			f'0.0.0.0:{port}',
			'--wait-for-client',
			'-m',
			'pytest',
			'-v',
			'--no-pdb',
		]

		if test_path:
			cmd.append(test_path)
		else:
			cmd.append('deadtrees-cli/tests/')

		print(f'Starting CLI debug session on port {port}')
		print('Waiting for debugger to attach...')
		self._run_command(cmd)

	def test_data(self, test_path: Optional[str] = None):
		"""
		Run CLI tests without debugging

		Args:
		    test_path: Specific test file or directory to run
		"""
		cmd = [
			'python',
			'-m',
			'pytest',
			'-v',
		]

		if test_path:
			cmd.append(test_path)
		else:
			cmd.append('deadtrees-cli/tests/')

		print('Running CLI tests...')
		self._run_command(cmd)
