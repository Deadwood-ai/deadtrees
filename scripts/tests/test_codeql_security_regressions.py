import ast
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).parents[2]


class CodeQlSecurityRegressionTest(unittest.TestCase):
	def test_frontend_deploy_token_is_read_only(self):
		workflow = (REPO_ROOT / '.github/workflows/frontend-hosting-merge.yml').read_text()

		self.assertIn('\npermissions:\n  contents: read\n', workflow)

	def test_sam_error_response_does_not_expose_exception_details(self):
		source = (REPO_ROOT / 'frontend/docs/scratchpad/sam_api.py').read_text()
		module = ast.parse(source)
		handler = next(
			node
			for node in ast.walk(module)
			if isinstance(node, ast.ExceptHandler) and isinstance(node.type, ast.Name) and node.type.id == 'Exception'
		)
		response = next(node for node in handler.body if isinstance(node, ast.Return))

		self.assertFalse(any(isinstance(node, ast.Name) and node.id == handler.name for node in ast.walk(response)))
		self.assertTrue(
			any(isinstance(node, ast.Constant) and node.value == 'Segmentation failed' for node in ast.walk(response))
		)
