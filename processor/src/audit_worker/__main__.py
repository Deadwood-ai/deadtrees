"""Command line of the audit worker.

	python -m processor.src.audit_worker probe                 # are the logins there (no model call)
	python -m processor.src.audit_worker probe --serve codex:gpt-6-luna:medium   # one call, synthetic image
	python -m processor.src.audit_worker enqueue --check prediction_quality --queue backfill --file ids.txt
	python -m processor.src.audit_worker status
	systemd-run --user --scope -p MemoryMax=10G -- python -m processor.src.audit_worker run

`run` refuses to start without a memory cap of at most 10 GB, because production ODM runs on
this host. Enqueueing and running write to the database: the backfill and the first live run
each need approval.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from . import models, runs, worker


def connect():
	from shared.db import login, use_client
	from shared.settings import settings

	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
	with use_client(token) as client:
		return client, token


def put_image_with(token_source):
	"""Store an image on the storage server below its data directory, as the processor does for files."""
	from processor.src.utils.ssh import push_file_to_storage_server
	from shared.settings import settings

	def put(path: str, data: bytes, dataset_id: int = 0) -> None:
		with tempfile.NamedTemporaryFile(suffix=Path(path).suffix) as tmp:
			tmp.write(data)
			tmp.flush()
			push_file_to_storage_server(
				tmp.name, f'{settings.STORAGE_SERVER_DATA_PATH}/{path}', token_source(), dataset_id
			)

	return put


def read_ids(args) -> list[int]:
	ids = [int(i) for i in (args.dataset_ids or '').split(',') if i.strip()]
	if args.file:
		ids += [int(line) for line in Path(args.file).read_text().split() if line.strip()]
	return ids


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(
		prog='audit_worker', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
	)
	sub = parser.add_subparsers(dest='command', required=True)
	run = sub.add_parser('run')
	run.add_argument('--once', action='store_true', help='process at most one run, then stop')
	run.add_argument('--benchmark', action='store_true', help='work the benchmark queue only')
	enqueue = sub.add_parser('enqueue')
	enqueue.add_argument('--check', required=True)
	enqueue.add_argument('--queue', choices=('backfill', 'manual', 'benchmark'), default='backfill')
	enqueue.add_argument('--dataset-ids', help='comma separated')
	enqueue.add_argument('--file', help='one dataset id per line')
	enqueue.add_argument('--force', action='store_true', help='queue even where a run on the same evidence exists')
	sub.add_parser('status')
	probe = sub.add_parser('probe')
	probe.add_argument('--serve', help='transport:model[:effort] to send one synthetic test image to')
	args = parser.parse_args(argv)

	if args.command == 'status':
		print(json.dumps(worker.read_status(), indent=1))
		return 0
	if args.command == 'probe':
		report = {'claude_logged_in': models.claude_logged_in(), 'codex_logged_in': models.codex_logged_in()}
		if args.serve:
			from PIL import Image

			transport, model, *effort = args.serve.split(':')
			backend = models.judges(
				{'probe': {'transport': transport, 'model': model, 'effort': effort[0] if effort else None}}
			)
			try:
				answer = backend['probe'](
					'Image 1 is a plain grey test square. Reply with the JSON {"grey": true} only.',
					[Image.new('RGB', (64, 64), 'grey')],
				)
				report['serve'] = {'model': model, 'answer': answer[:200]}
			except models.ModelError as exc:
				report['serve'] = {'model': model, 'error': str(exc)[:300], 'kind': type(exc).__name__}
		print(json.dumps(report, indent=1))
		return 0

	handlers, missing = worker.load_handlers()
	for check, why in missing.items():
		print(f'{check}: handler not importable ({why})', file=sys.stderr)
	if not handlers:
		print('No check handler is registered yet (worker.HANDLERS); nothing to do.', file=sys.stderr)
		return 1
	client, token = connect()
	if args.command == 'enqueue':
		if args.check not in handlers:
			parser.error(f'no handler for {args.check}')
		active = runs.active_versions(client, [args.check]).get(args.check)
		if active is None:
			parser.error(f'{args.check} has no active version; an operator activates one first')
		ids = read_ids(args)
		ids, inputs = worker.judged_inputs(handlers[args.check], client, ids)
		added = runs.enqueue(client, active, ids, args.queue, inputs=inputs, force=args.force)
		print(json.dumps({'check': args.check, 'version': active['version'], 'queue': args.queue, 'added': len(added)}))
		return 0

	limit = worker.memory_limit()
	if limit is None or limit > worker.MEMORY_LIMIT:
		print(
			'Start the worker under a memory cap of at most 10 GB, e.g.\n'
			'  systemd-run --user --scope -p MemoryMax=10G -- python -m processor.src.audit_worker run',
			file=sys.stderr,
		)
		return 2
	worker.register(client, handlers)
	token_box = {'token': token}

	def fresh():
		client, token_box['token'] = connect()
		return client, token_box['token']

	status = worker.run_forever(
		connect=fresh,
		handlers=handlers,
		put_image=put_image_with(lambda: token_box['token']),
		benchmark=args.benchmark,
		once=args.once,
	)
	print(json.dumps(status))
	return 0


if __name__ == '__main__':
	sys.exit(main())
