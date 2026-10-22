import datetime as dt
import io
import json
import re
import sys
import tempfile
import tomllib
import unittest
from contextlib import redirect_stdout
from pathlib import Path


REPO_ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(REPO_ROOT / 'scripts'))

import security_audit  # noqa: E402


TODAY = dt.date(2026, 10, 22)

CONFIG = {
	'stack': [{'name': 'Linux kernel', 'runs': 'all hosts', 'kev': '^Linux Kernel$'}],
	'accepted': [
		{'package': 'torch', 'version': '2.6.0', 'reason': 'held', 'issue': 'DT-859', 'review_by': '2027-01-31'},
		{
			'package': 'tailwindcss',
			'ids': ['GHSA-aaaa-bbbb-cccc'],
			'reason': 'build only',
			'issue': 'DT-1433',
			'review_by': '2027-01-31',
		},
	],
}


def pip_result(name, version, vuln_id, aliases=(), fixes=()):
	return {
		'dependencies': [
			{
				'name': name,
				'version': version,
				'vulns': [{'id': vuln_id, 'aliases': list(aliases), 'fix_versions': list(fixes)}],
			}
		]
	}


def npm_result(name, severity, ghsa):
	return {
		'vulnerabilities': {
			name: {
				'name': name,
				'severity': severity,
				'fixAvailable': True,
				'via': [
					{
						'source': 1,
						'name': name,
						'severity': severity,
						'url': f'https://github.com/advisories/{ghsa}',
						'range': '<2',
					}
				],
			}
		}
	}


def trivy_result(cve, severity='HIGH', fixed=''):
	return {
		'Results': [
			{
				'Vulnerabilities': [
					{
						'VulnerabilityID': cve,
						'PkgName': 'openssl',
						'InstalledVersion': '3.0.13',
						'FixedVersion': fixed,
						'Severity': severity,
					}
				]
			}
		]
	}


def kev(*entries):
	return {'catalogVersion': '2026.10.21', 'vulnerabilities': list(entries)}


def kev_entry(cve, added, vendor='Linux', product='Kernel'):
	return {'cveID': cve, 'dateAdded': added, 'vendorProject': vendor, 'product': product, 'vulnerabilityName': 'Test'}


def classify(findings, kev_data=None, config=CONFIG, stack_watch=False):
	report = security_audit.Report(findings=findings)
	security_audit.classify(report, kev_data, config, TODAY, stack_watch, 7)
	return report


class ClassifyTest(unittest.TestCase):
	def test_new_python_advisory_is_red_and_held_version_is_accepted(self):
		findings = security_audit.parse_pip_audit(pip_result('urllib3', '2.7.0', 'PYSEC-1', fixes=['2.8.0']), 'api')
		findings += security_audit.parse_pip_audit(pip_result('torch', '2.6.0', 'PYSEC-2'), 'processor')
		report = classify(findings)

		red = {f.package for f in report.findings if f.red}
		self.assertEqual(red, {'urllib3'})
		self.assertEqual(next(f for f in report.findings if f.package == 'torch').accepted_by, 'DT-859')

	def test_accepted_version_does_not_cover_a_new_version(self):
		report = classify(security_audit.parse_pip_audit(pip_result('torch', '2.7.0', 'PYSEC-3'), 'api'))

		self.assertTrue(report.red)

	def test_npm_high_is_red_but_moderate_and_accepted_ids_are_not(self):
		findings = security_audit.parse_npm_audit(npm_result('lodash', 'high', 'GHSA-xxxx-xxxx-xxxx'), 'frontend')
		findings += security_audit.parse_npm_audit(npm_result('nanoid', 'moderate', 'GHSA-yyyy-yyyy-yyyy'), 'frontend')
		findings += security_audit.parse_npm_audit(npm_result('braces', 'high', 'GHSA-aaaa-bbbb-cccc'), 'frontend')
		report = classify(findings)

		self.assertEqual({f.package for f in report.findings if f.red}, {'lodash'})
		self.assertEqual(next(f for f in report.findings if f.package == 'braces').accepted_by, 'DT-1433')

	def test_kev_listed_finding_is_red_even_when_accepted_or_in_the_image(self):
		findings = security_audit.parse_pip_audit(
			pip_result('torch', '2.6.0', 'PYSEC-4', aliases=['CVE-2026-1']), 'api'
		)
		findings += security_audit.parse_trivy(trivy_result('CVE-2026-2'), 'gdal base image')
		findings += security_audit.parse_trivy(trivy_result('CVE-2026-3', 'CRITICAL', '3.0.14'), 'gdal base image')
		report = classify(findings, kev(kev_entry('CVE-2026-1', '2025-01-01'), kev_entry('CVE-2026-2', '2025-01-01')))

		self.assertEqual({f.advisory for f in report.findings if f.red}, {'PYSEC-4', 'CVE-2026-2'})

	def test_stack_watch_reports_recent_matching_kev_entries_only(self):
		data = kev(
			kev_entry('CVE-NEW', '2026-10-20'),
			kev_entry('CVE-OLD', '2026-09-01'),
			kev_entry('CVE-OTHER', '2026-10-21', vendor='Plex', product='Media Server'),
		)

		self.assertEqual([hit['cveID'] for hit in classify([], data, stack_watch=True).stack_hits], ['CVE-NEW'])
		self.assertEqual(classify([], data, stack_watch=False).stack_hits, [])

	def test_accepted_risk_past_review_date_is_red(self):
		config = {**CONFIG, 'accepted': [{**CONFIG['accepted'][0], 'review_by': '2026-10-01'}]}

		report = classify([], config=config)

		self.assertTrue(report.red)
		self.assertEqual(report.expired[0]['package'], 'torch')

	def test_duplicate_pip_ids_merge_aliases(self):
		data = {
			'dependencies': [
				{
					'name': 'torch',
					'version': '2.6.0',
					'vulns': [
						{'id': 'PYSEC-5', 'aliases': ['CVE-A'], 'fix_versions': []},
						{'id': 'PYSEC-5', 'aliases': ['GHSA-B'], 'fix_versions': ['2.7.0']},
					],
				}
			]
		}

		(finding,) = security_audit.parse_pip_audit(data, 'api')

		self.assertEqual(finding.ids, {'PYSEC-5', 'CVE-A', 'GHSA-B'})
		self.assertEqual(finding.fix, '2.7.0')


class ZizmorTest(unittest.TestCase):
	def test_primary_location_gives_file_and_line(self):
		finding = {
			'ident': 'template-injection',
			'determinations': {'severity': 'High', 'confidence': 'High'},
			'locations': [
				{
					'symbolic': {'key': {'Local': {'verbatim_path': 'a.yml'}}, 'kind': 'Related'},
					'concrete': {'location': {'start_point': {'row': 1}}},
				},
				{
					'symbolic': {'key': {'Local': {'verbatim_path': 'a.yml'}}, 'kind': 'Primary'},
					'concrete': {'location': {'start_point': {'row': 57}}},
				},
			],
		}

		(item,) = security_audit.parse_zizmor([finding])

		self.assertEqual(
			item, {'ident': 'template-injection', 'severity': 'high', 'confidence': 'high', 'where': 'a.yml:58'}
		)


CLEAN = {
	'pip-api.json': {'dependencies': []},
	'npm-frontend.json': {'vulnerabilities': {}},
	'trivy-base-image.json': {'Results': []},
	'zizmor.json': [],
	'kev.json': kev(),
}


class MainTest(unittest.TestCase):
	def run_main(self, files, *extra, missing=''):
		with tempfile.TemporaryDirectory() as tmp:
			results = Path(tmp)
			for name, data in files.items():
				(results / name).write_text(json.dumps(data))
			if missing:
				(results / 'missing.txt').write_text(missing)
			config = results / 'stack.toml'
			config.write_text("[[stack]]\nname = 'Linux'\nkev = '^Linux Kernel$'\n")
			out = io.StringIO()
			with redirect_stdout(out):
				code = security_audit.main(
					[
						str(results),
						'--config',
						str(config),
						'--kev',
						str(results / 'kev.json'),
						'--today',
						'2026-10-22',
						*extra,
					]
				)
			return code, out.getvalue()

	def test_clean_scans_are_green(self):
		code, out = self.run_main(CLEAN, '--stack-watch')

		self.assertEqual(code, 0, out)
		self.assertIn('GREEN', out)

	def test_missing_scans_are_not_a_pass(self):
		files = {name: data for name, data in CLEAN.items() if not name.startswith('pip-')}

		code, out = self.run_main(files)

		self.assertEqual(code, 1)
		self.assertIn('INCOMPLETE', out)
		self.assertIn('python', out)

	def test_failed_scans_are_not_a_pass(self):
		files = {**CLEAN, 'npm-frontend.json': {'error': {'code': 'ENOTFOUND'}}}

		code, out = self.run_main(files, missing='python processor\n')

		self.assertEqual(code, 1)
		self.assertIn('npm', out)
		self.assertIn('python processor', out)

	def test_skipped_scan_is_not_missing(self):
		files = {name: data for name, data in CLEAN.items() if name != 'trivy-base-image.json'}

		self.assertEqual(self.run_main(files)[0], 1)
		self.assertEqual(self.run_main(files, '--skip', 'image')[0], 0)


class StackConfigTest(unittest.TestCase):
	def test_repo_config_is_valid(self):
		config = tomllib.loads((REPO_ROOT / 'scripts/security_stack.toml').read_text())

		self.assertTrue(config['stack'])
		for item in config['stack']:
			re.compile(item['kev'])
		for entry in config['accepted']:
			self.assertTrue(entry['reason'] and entry['issue'])
			self.assertTrue(entry.get('ids') or entry.get('version'))
			dt.date.fromisoformat(entry['review_by'])


if __name__ == '__main__':
	unittest.main()
