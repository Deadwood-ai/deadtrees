import subprocess
import os
import signal
import shutil
from pathlib import Path
from typing import Optional, List
from datetime import datetime

from supabase import create_client
from shared.settings import settings
from shared.db import login, use_client
from shared.testing.safety import ensure_test_environment


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

	def _setup_test_users(self):
		"""Create test users for development environment if they don't exist"""
		ensure_test_environment()

		print('Setting up test users...')
		supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)

		users_to_create = [
			{'email': settings.TEST_USER_EMAIL, 'password': settings.TEST_USER_PASSWORD, 'name': 'Test User'},
			{'email': settings.TEST_USER_EMAIL2, 'password': settings.TEST_USER_PASSWORD2, 'name': 'Test User 2'},
			{'email': settings.PROCESSOR_USERNAME, 'password': settings.PROCESSOR_PASSWORD, 'name': 'Processor User'},
		]

		for user_info in users_to_create:
			try:
				# Try to sign up the user
				response = supabase.auth.sign_up({'email': user_info['email'], 'password': user_info['password']})
				if response.user:
					print(f'✓ Created user: {user_info["email"]}')
				else:
					print(f'? User creation unclear: {user_info["email"]}')
			except Exception as e:
				# If user already exists, try to sign in to verify
				try:
					response = supabase.auth.sign_in_with_password(
						{'email': user_info['email'], 'password': user_info['password']}
					)
					if response.user:
						print(f'✓ User already exists: {user_info["email"]}')
					else:
						print(f'⚠ Could not verify user: {user_info["email"]}')
				except Exception as sign_in_error:
					print(f'⚠ User setup issue for {user_info["email"]}: {str(sign_in_error)}')

	def _cleanup_development_environment(self):
		"""Clean up database and directories like test fixtures do"""
		ensure_test_environment()

		print('Cleaning up development environment...')

		try:
			# Get processor token for cleanup operations (like test fixtures)
			processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

			# Clean database (following cleanup_database fixture pattern)
			print('Cleaning database tables...')
			with use_client(processor_token) as client:
				# Delete datasets (cascades to related tables)
				client.table(settings.datasets_table).delete().neq('id', 0).execute()
				# Clean logs except first entry
				client.table(settings.logs_table).delete().neq('id', 1).execute()

			# Clean directory structure (following data_directory fixture pattern)
			print('Cleaning directories...')
			data_dir = Path(settings.BASE_DIR)
			directories_to_clean = [
				data_dir / settings.ARCHIVE_DIR,
				data_dir / settings.COG_DIR,
				data_dir / settings.THUMBNAIL_DIR,
				data_dir / settings.LABEL_OBJECTS_DIR,
				data_dir / settings.TRASH_DIR,
				data_dir / settings.DOWNLOADS_DIR,
				data_dir / settings.RAW_IMAGES_DIR,
				data_dir / settings.PROCESSING_DIR,
			]

			for directory in directories_to_clean:
				if directory.exists():
					try:
						shutil.rmtree(directory)
						# Recreate empty directory
						directory.mkdir(parents=True, exist_ok=True)
						print(f'✓ Cleaned: {directory}')
					except Exception as e:
						print(f'⚠ Could not clean {directory}: {str(e)}')

			print('✓ Development environment cleanup completed')

		except Exception as e:
			print(f'⚠ Cleanup error: {str(e)}')

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

		# Signal handler for graceful cleanup
		def signal_handler(sig, frame):
			print('\n🛑 Received interrupt signal. Cleaning up...')
			self._cleanup_development_environment()
			print('👋 Goodbye!')
			exit(0)

		# Register signal handlers
		signal.signal(signal.SIGINT, signal_handler)  # Ctrl+C
		signal.signal(signal.SIGTERM, signal_handler)  # Termination

		try:
			# Setup test users first
			self._setup_test_users()

			# Build and start all services
			print('Starting development environment...')
			self._run_command(['docker', 'compose', '-f', self.test_compose_file, 'up', '-d', '--build'])

			print('🚀 Development environment started!')
			print('📧 Available test users:')
			print(f'   • Test User: {settings.TEST_USER_EMAIL} / {settings.TEST_USER_PASSWORD}')
			print(f'   • Test User 2: {settings.TEST_USER_EMAIL2} / {settings.TEST_USER_PASSWORD2}')
			print(f'   • Processor: {settings.PROCESSOR_USERNAME} / {settings.PROCESSOR_PASSWORD}')
			print('')
			print('🔄 Starting continuous processor... (Press Ctrl+C to stop and cleanup)')

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

		except KeyboardInterrupt:
			print('\n🛑 Keyboard interrupt received. Cleaning up...')
			self._cleanup_development_environment()
			print('👋 Goodbye!')
		except Exception as e:
			print(f'\n❌ Error in run_dev: {str(e)}')
			print('🧹 Running cleanup before exit...')
			self._cleanup_development_environment()
			raise
		finally:
			# Always run cleanup when exiting
			print('\n🧹 Final cleanup...')
			self._cleanup_development_environment()

	def cleanup(self):
		"""Manually clean up the development environment (database and directories)"""
		print('🧹 Manual cleanup requested...')
		self._cleanup_development_environment()

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
