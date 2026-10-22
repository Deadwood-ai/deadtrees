#!/usr/bin/env python3
"""Summarize the security-audit scans and decide whether the run is red.

The workflow (.github/workflows/security-audit.yml) runs the scanners and
writes their JSON output into one directory. This script reads it together
with the CISA Known Exploited Vulnerabilities feed and
scripts/security_stack.toml, prints a Markdown report and exits 1 when
something needs a decision:

- a Python or base-image finding that is on the KEV list (npm audit only
  gives GHSA ids, so npm findings can't be matched)
- a Python advisory that is not accepted in security_stack.toml
- an npm high or critical advisory that is not accepted
- an accepted finding whose review date has passed
- with --stack-watch: a KEV entry added in the last --kev-window-days days
  that matches a [[stack]] entry (software the scans cannot see), unless its
  CVE is listed in an [[accepted]] entry's ids

Workflow findings (zizmor) and image findings without a KEV match are listed
but never turn the run red. Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


SEVERITY_ORDER = {'critical': 4, 'high': 3, 'moderate': 2, 'medium': 2, 'low': 1, 'unknown': 0}
GHSA_RE = re.compile(r'GHSA(-[a-z0-9]{4}){3}')


@dataclass
class Finding:
	source: str
	package: str
	version: str
	advisory: str
	aliases: set[str] = field(default_factory=set)
	severity: str = 'unknown'
	fix: str = ''
	target: str = ''
	red: bool = False
	reasons: list[str] = field(default_factory=list)
	accepted_by: str = ''

	@property
	def ids(self) -> set[str]:
		return {self.advisory, *self.aliases}


@dataclass
class Report:
	findings: list[Finding] = field(default_factory=list)
	stack_hits: list[dict] = field(default_factory=list)
	expired: list[dict] = field(default_factory=list)
	workflow: list[dict] = field(default_factory=list)
	image_counts: dict[str, int] = field(default_factory=dict)
	missing: list[str] = field(default_factory=list)

	@property
	def red(self) -> bool:
		return any(f.red for f in self.findings) or bool(self.stack_hits) or bool(self.expired)


def load_json(path: Path):
	with path.open(encoding='utf-8') as handle:
		return json.load(handle)


def parse_pip_audit(data: dict, target: str) -> list[Finding]:
	findings: dict[tuple[str, str], Finding] = {}
	for dep in data.get('dependencies', []):
		for vuln in dep.get('vulns', []):
			key = (dep['name'].lower(), vuln['id'])
			fixes = ', '.join(vuln.get('fix_versions') or [])
			existing = findings.get(key)
			if existing:
				existing.aliases.update(vuln.get('aliases') or [])
				existing.fix = existing.fix or fixes
				continue
			findings[key] = Finding(
				source='python',
				package=dep['name'].lower(),
				version=dep.get('version', ''),
				advisory=vuln['id'],
				aliases=set(vuln.get('aliases') or []),
				fix=fixes,
				target=target,
			)
	return list(findings.values())


def parse_npm_audit(data: dict, target: str) -> list[Finding]:
	findings: dict[tuple[str, str], Finding] = {}
	for entry in data.get('vulnerabilities', {}).values():
		fix = entry.get('fixAvailable')
		if isinstance(fix, dict):
			fix_text = f'{fix.get("name")}@{fix.get("version")}' + (' (major)' if fix.get('isSemVerMajor') else '')
		else:
			fix_text = 'yes' if fix else ''
		for via in entry.get('via', []):
			if not isinstance(via, dict):
				continue
			url = via.get('url', '')
			match = GHSA_RE.search(url)
			advisory = match.group(0) if match else str(via.get('source', url))
			key = (via.get('name', entry['name']), advisory)
			if key in findings:
				continue
			findings[key] = Finding(
				source='npm',
				package=key[0],
				# npm audit has no installed version; this is the affected range.
				version=f'affected {via.get("range", "?")}',
				advisory=advisory,
				severity=via.get('severity', 'unknown'),
				fix=fix_text,
				target=target,
			)
	return list(findings.values())


def parse_trivy(data: dict, target: str) -> list[Finding]:
	findings: dict[tuple[str, str], Finding] = {}
	for result in data.get('Results') or []:
		for vuln in result.get('Vulnerabilities') or []:
			key = (vuln['PkgName'], vuln['VulnerabilityID'])
			if key in findings:
				continue
			findings[key] = Finding(
				source='image',
				package=vuln['PkgName'],
				version=vuln.get('InstalledVersion', ''),
				advisory=vuln['VulnerabilityID'],
				severity=vuln.get('Severity', 'unknown').lower(),
				fix=vuln.get('FixedVersion', ''),
				target=target,
			)
	return list(findings.values())


def parse_zizmor(data: list) -> list[dict]:
	items = []
	for finding in data:
		locations = finding.get('locations') or []
		primary = next(
			(loc for loc in locations if loc['symbolic'].get('kind') == 'Primary'), locations[0] if locations else None
		)
		where = ''
		if primary:
			local = primary['symbolic']['key'].get('Local', {})
			path = local.get('verbatim_path') or local.get('given_path') or ''
			row = primary['concrete']['location']['start_point']['row'] + 1
			where = f'{path}:{row}'
		items.append(
			{
				'ident': finding['ident'],
				'severity': finding['determinations']['severity'].lower(),
				'confidence': finding['determinations']['confidence'].lower(),
				'where': where,
			}
		)
	return items


def accepted_entry(finding: Finding, accepted: list[dict]) -> dict | None:
	for entry in accepted:
		if entry.get('ids') and finding.ids & set(entry['ids']):
			return entry
		if (
			entry.get('version')
			and entry.get('package', '').lower() == finding.package.lower()
			and version_matches(entry['version'], finding.version)
		):
			return entry
	return None


def version_matches(pattern: str, version: str) -> bool:
	"""Exact version, or a prefix ending in '*' (for example '4.*' for a package held below 5)."""
	if pattern.endswith('*'):
		return version.startswith(pattern[:-1])
	return pattern == version


def validate_config(config: dict) -> list[str]:
	errors = []
	for item in config.get('stack', []):
		if not item.get('name') or not item.get('kev'):
			errors.append(f'[[stack]] entry needs name and kev: {item}')
			continue
		try:
			re.compile(item['kev'])
		except re.error as exc:
			errors.append(f'[[stack]] {item["name"]}: bad kev pattern ({exc})')
	for entry in config.get('accepted', []):
		label = entry.get('package') or entry.get('ids')
		if not (entry.get('reason') and entry.get('issue') and entry.get('review_by')):
			errors.append(f'[[accepted]] {label}: needs reason, issue and review_by')
		if not (entry.get('ids') or (entry.get('package') and entry.get('version'))):
			errors.append(f'[[accepted]] {label}: needs ids, or package and version')
		try:
			dt.date.fromisoformat(str(entry.get('review_by')))
		except ValueError:
			errors.append(f'[[accepted]] {label}: review_by must be a YYYY-MM-DD date')
	return errors


def classify(report: Report, kev: dict | None, config: dict, today: dt.date, stack_watch: bool, window_days: int):
	kev_entries = (kev or {}).get('vulnerabilities', [])
	kev_ids = {entry['cveID'] for entry in kev_entries}
	accepted = []
	for entry in config.get('accepted', []):
		if dt.date.fromisoformat(str(entry['review_by'])) < today:
			report.expired.append(entry)
		else:
			accepted.append(entry)
	acknowledged_ids = {advisory for entry in accepted for advisory in entry.get('ids', [])}

	for finding in report.findings:
		if finding.ids & kev_ids:
			finding.red = True
			finding.reasons.append('on CISA KEV (exploited)')
		entry = accepted_entry(finding, accepted)
		if entry:
			finding.accepted_by = entry.get('issue', 'accepted')
			continue
		if finding.source == 'python':
			finding.red = True
			finding.reasons.append('new Python advisory')
		elif finding.source == 'npm' and SEVERITY_ORDER.get(finding.severity, 0) >= SEVERITY_ORDER['high']:
			finding.red = True
			finding.reasons.append(f'npm {finding.severity}')

	if stack_watch:
		cutoff = today - dt.timedelta(days=window_days)
		for entry in kev_entries:
			if dt.date.fromisoformat(entry['dateAdded']) <= cutoff or entry['cveID'] in acknowledged_ids:
				continue
			label = f'{entry["vendorProject"]} {entry["product"]}'
			for item in config.get('stack', []):
				if re.search(item['kev'], label, re.IGNORECASE):
					report.stack_hits.append({**entry, 'stack': item['name'], 'runs': item.get('runs', '')})
					break


def render(report: Report, today: dt.date, kev: dict | None) -> str:
	if report.red:
		status = 'RED: needs a decision'
	elif report.missing:
		status = 'INCOMPLETE: a scan is missing'
	else:
		status = 'GREEN: nothing new'
	lines = [f'# Security audit {today.isoformat()}: {status}', '']
	if kev:
		lines.append(
			f'CISA KEV catalog {kev.get("catalogVersion", "?")} ({len(kev.get("vulnerabilities", []))} entries).'
		)
	if report.missing:
		lines.append(f'Missing scan results (unknown, not a pass): {", ".join(report.missing)}.')
	lines.append('')

	red = [f for f in report.findings if f.red]
	if red:
		lines += [
			'## Red findings',
			'',
			'| Source | Target | Package | Version | Advisory | Fix | Why |',
			'|---|---|---|---|---|---|---|',
		]
		for f in sorted(red, key=lambda f: (f.source, f.package, f.advisory)):
			lines.append(
				f'| {f.source} | {f.target} | {f.package} | {f.version} | {f.advisory} | {f.fix or "none"} | {"; ".join(f.reasons)} |'
			)
		lines.append('')

	if report.stack_hits:
		lines += ['## New exploited CVEs matching our stack', '']
		for hit in report.stack_hits:
			lines.append(
				f'- {hit["cveID"]} ({hit["dateAdded"]}): {hit["vendorProject"]} {hit["product"]}, '
				f'{hit["vulnerabilityName"]}. Stack: {hit["stack"]} ({hit["runs"]}). Check whether our version is affected.'
			)
		lines.append('')

	if report.expired:
		lines += ['## Accepted risks past their review date', '']
		for entry in report.expired:
			lines.append(f'- {entry.get("package")} ({entry.get("issue")}): review was due {entry["review_by"]}.')
		lines.append('')

	accepted = [f for f in report.findings if f.accepted_by and not f.red]
	if accepted:
		lines += ['## Accepted', '']
		grouped: dict[tuple[str, str], set[str]] = {}
		for f in accepted:
			grouped.setdefault((f.package, f.accepted_by), set()).add(f.advisory)
		for (package, issue), advisories in sorted(grouped.items()):
			lines.append(f'- {package}: {len(advisories)} advisories ({issue})')
		lines.append('')

	other = [f for f in report.findings if not f.red and not f.accepted_by and f.source != 'image']
	if other:
		lines += ['## Lower severity, not red', '']
		for f in sorted(other, key=lambda f: (f.source, f.package)):
			lines.append(f'- {f.source} {f.package} {f.version}: {f.advisory} ({f.severity}), fix {f.fix or "none"}')
		lines.append('')

	if report.image_counts:
		counts = ', '.join(f'{k} {v}' for k, v in sorted(report.image_counts.items()))
		lines += ['## Base image (OS packages)', '', f'High and critical CVEs: {counts}. Red only if on CISA KEV.', '']

	if report.workflow:
		lines += ['## Workflow audit (zizmor)', '']
		grouped_w: dict[tuple[str, str], list[str]] = {}
		for item in report.workflow:
			grouped_w.setdefault((item['ident'], item['severity']), []).append(item['where'])
		for (ident, severity), wheres in sorted(
			grouped_w.items(), key=lambda kv: (-SEVERITY_ORDER.get(kv[0][1], 0), kv[0][0])
		):
			sample = ', '.join(sorted(set(wheres))[:3])
			lines.append(f'- {ident} ({severity}): {len(wheres)}, e.g. {sample}')
		lines.append('')

	return '\n'.join(lines).rstrip() + '\n'


def read_result(path: Path, name: str, report: Report):
	"""Return the scanner JSON, or record the scan as missing (unknown is not a pass)."""
	try:
		data = load_json(path)
	except (OSError, ValueError):
		report.missing.append(name)
		return None
	if isinstance(data, dict) and 'error' in data:
		report.missing.append(name)
		return None
	return data


def build_report(results: Path, skip: set[str] = frozenset()) -> Report:
	report = Report()
	missing_file = results / 'missing.txt'
	if missing_file.exists():
		report.missing += [line.strip() for line in missing_file.read_text().splitlines() if line.strip()]
	pip_files = sorted(results.glob('pip-*.json'))
	if not pip_files and 'python' not in skip:
		report.missing.append('python')
	for path in pip_files:
		target = path.stem.removeprefix('pip-')
		data = read_result(path, f'python {target}', report)
		if data is not None:
			report.findings += parse_pip_audit(data, target)
	if 'npm' not in skip:
		data = read_result(results / 'npm-frontend.json', 'npm', report)
		if data is not None:
			report.findings += parse_npm_audit(data, 'frontend')
	if 'image' not in skip:
		data = read_result(results / 'trivy-base-image.json', 'image', report)
		if data is not None:
			image = parse_trivy(data, 'gdal base image')
			report.findings += image
			for f in image:
				label = f'{f.severity}{" fixable" if f.fix else ""}'
				report.image_counts[label] = report.image_counts.get(label, 0) + 1
	if 'workflows' not in skip:
		data = read_result(results / 'zizmor.json', 'workflows', report)
		if data is not None:
			report.workflow = parse_zizmor(data)
	return report


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	parser.add_argument('results', type=Path, help='directory with the scanner JSON files')
	parser.add_argument('--config', type=Path, default=Path(__file__).with_name('security_stack.toml'))
	parser.add_argument('--kev', type=Path, help='CISA KEV JSON feed')
	parser.add_argument('--stack-watch', action='store_true', help='also report new KEV entries for our stack')
	parser.add_argument('--kev-window-days', type=int, default=7)
	parser.add_argument('--today', type=dt.date.fromisoformat, default=dt.date.today())
	parser.add_argument('--summary', type=Path, help='append the Markdown report here (GITHUB_STEP_SUMMARY)')
	parser.add_argument('--json', type=Path, help='write red findings as JSON here')
	parser.add_argument(
		'--skip',
		action='append',
		default=[],
		choices=['python', 'npm', 'image', 'workflows'],
		help='scan deliberately not run in this context (not reported as missing)',
	)
	args = parser.parse_args(argv)

	config = tomllib.loads(args.config.read_text(encoding='utf-8'))
	errors = validate_config(config)
	if errors:
		print(f'Invalid {args.config}:', *errors, sep='\n- ', file=sys.stderr)
		return 2
	kev = load_json(args.kev) if args.kev and args.kev.exists() else None
	report = build_report(args.results, set(args.skip))
	if kev is None:
		report.missing.append('kev')
	classify(report, kev, config, args.today, args.stack_watch, args.kev_window_days)

	markdown = render(report, args.today, kev)
	print(markdown)
	if args.summary:
		with args.summary.open('a', encoding='utf-8') as handle:
			handle.write(markdown)
	if args.json:
		red = [
			{
				'source': f.source,
				'target': f.target,
				'package': f.package,
				'version': f.version,
				'advisory': f.advisory,
				'fix': f.fix,
				'why': f.reasons,
			}
			for f in report.findings
			if f.red
		]
		args.json.write_text(
			json.dumps({'red': red, 'stack_hits': report.stack_hits, 'missing': report.missing}, indent=2),
			encoding='utf-8',
		)
	return 1 if report.red or report.missing else 0


if __name__ == '__main__':
	sys.exit(main())
