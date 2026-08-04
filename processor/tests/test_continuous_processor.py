import pytest

import processor.src.continuous_processor as continuous_processor_module

pytestmark = pytest.mark.unit


class StopLoop(Exception):
	pass


def _patch_startup(monkeypatch, *, exception_messages=None):
	monkeypatch.setattr(continuous_processor_module, 'login', lambda username, password: 'token')
	monkeypatch.setattr(continuous_processor_module, 'cleanup_orphaned_resources', lambda token: None)
	monkeypatch.setattr(continuous_processor_module, 'cleanup_old_temp_directories', lambda token: None)
	monkeypatch.setattr(continuous_processor_module.logger, 'info', lambda *args, **kwargs: None)
	if exception_messages is None:
		monkeypatch.setattr(continuous_processor_module.logger, 'exception', lambda *args, **kwargs: None)
	else:
		monkeypatch.setattr(
			continuous_processor_module.logger,
			'exception',
			lambda *args, **kwargs: exception_messages.append(args[0]),
		)


def test_run_continuous_drains_back_to_back_before_sleeping(monkeypatch):
	_patch_startup(monkeypatch)
	results = iter([True, True, False])
	sleep_calls = []

	monkeypatch.setattr(continuous_processor_module, 'is_drain_requested', lambda: False)
	monkeypatch.setattr(continuous_processor_module, 'background_process', lambda: next(results))
	monkeypatch.setattr(continuous_processor_module.settings, 'PROCESSOR_IDLE_BACKOFF_SECONDS', 7)

	def fake_sleep(seconds):
		sleep_calls.append(seconds)
		raise StopLoop

	monkeypatch.setattr(continuous_processor_module.time, 'sleep', fake_sleep)

	with pytest.raises(StopLoop):
		continuous_processor_module.run_continuous()

	assert sleep_calls == [7]


def test_run_continuous_backs_off_while_drained(monkeypatch):
	_patch_startup(monkeypatch)
	sleep_calls = []

	monkeypatch.setattr(continuous_processor_module, 'is_drain_requested', lambda: True)
	monkeypatch.setattr(
		continuous_processor_module,
		'background_process',
		lambda: pytest.fail('drained worker should not poll the queue'),
	)
	monkeypatch.setattr(continuous_processor_module.settings, 'PROCESSOR_IDLE_BACKOFF_SECONDS', 9)

	def fake_sleep(seconds):
		sleep_calls.append(seconds)
		raise StopLoop

	monkeypatch.setattr(continuous_processor_module.time, 'sleep', fake_sleep)

	with pytest.raises(StopLoop):
		continuous_processor_module.run_continuous()

	assert sleep_calls == [9]


def test_run_continuous_logs_tracebacks_and_backs_off_on_loop_errors(monkeypatch):
	exception_messages = []
	_patch_startup(monkeypatch, exception_messages=exception_messages)
	sleep_calls = []

	monkeypatch.setattr(continuous_processor_module, 'is_drain_requested', lambda: False)
	monkeypatch.setattr(
		continuous_processor_module,
		'background_process',
		lambda: (_ for _ in ()).throw(RuntimeError('boom')),
	)
	monkeypatch.setattr(continuous_processor_module.settings, 'PROCESSOR_IDLE_BACKOFF_SECONDS', 5)

	def fake_sleep(seconds):
		sleep_calls.append(seconds)
		raise StopLoop

	monkeypatch.setattr(continuous_processor_module.time, 'sleep', fake_sleep)

	with pytest.raises(StopLoop):
		continuous_processor_module.run_continuous()

	assert exception_messages == ['Error in processor loop']
	assert sleep_calls == [5]
