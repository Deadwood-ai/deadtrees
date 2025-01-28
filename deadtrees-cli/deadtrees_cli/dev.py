import subprocess
from typing import Optional, List

class DevCommands:
    """Development environment management commands"""
    
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
        self._run_command([
            'docker', 'compose', 
            '-f', 
            self.test_compose_file, 
            'exec',
            'processor-test',
            'python', 
            '-m', 
            'debugpy', 
            '--listen', 
            '0.0.0.0:5678',
            '-m', 
            'processor.src.continuous_processor'
        ])

    def debug_cli(self, test_path: Optional[str] = None, port: int = 5680):
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
        ]

        if test_path:
            cmd.append(test_path)
        else:
            cmd.append('deadtrees-cli/tests/')

        print(f'Starting CLI debug session on port {port}')
        print('Waiting for debugger to attach...')
        self._run_command(cmd) 