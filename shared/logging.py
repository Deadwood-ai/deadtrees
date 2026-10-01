import json
import logging
from typing import Any, Dict, Optional
from enum import Enum
from shared.settings import settings
from shared.__version__ import __version__
from shared.db import use_service_client
from shared.redaction import storable_text


class LogCategory(Enum):
	# API Operations
	UPLOAD = 'upload'  # File upload operations
	DOWNLOAD = 'download'  # Download API operations
	DATASET = 'dataset'  # Dataset management
	LABEL = 'label'  # Label operations
	AUTH = 'auth'  # Authentication events
	ADD_PROCESS = 'add_process'  # Add processing operations

	# Processing Pipeline
	PROCESS = 'process'  # Processing operations
	ORTHO = 'ortho'  # Orthophoto processing
	ODM = 'odm'  # ODM raw image processing
	COG = 'cog'  # COG generation
	THUMBNAIL = 'thumb'  # Thumbnail creation
	DEADWOOD = 'deadwood'  # Deadwood segmentation
	TREECOVER = 'treecover'  # Tree cover segmentation
	AOI = 'aoi'  # Automatic area-of-interest segmentation
	FOREST = 'forest'  # Forest cover analysis
	EMBEDDINGS = 'embeddings'  # Open-vocabulary tile embeddings
	DOY = 'doy'  # Acquisition-date (day-of-year) estimation
	METADATA = 'metadata'  # Metadata processing

	# System Operations
	QUEUE = 'queue'  # Queue management
	STATUS = 'status'  # Status updates
	SSH = 'ssh'  # SSH operations


class LogContext:
	def __init__(
		self,
		category: LogCategory,
		dataset_id: Optional[int] = None,
		user_id: Optional[str] = None,
		extra: Optional[Dict[str, Any]] = None,
		token: Optional[str] = None,
	):
		self.category = category
		self.dataset_id = dataset_id
		self.user_id = user_id
		self.token = token
		self.extra = extra or {}


def redact_extra(extra: Any) -> Any:
	"""Structured log context often carries str(exception); scrub tokens from it too."""
	if extra is None:
		return None
	# JSON escapes NUL as \u0000, which Postgres jsonb rejects.
	return json.loads(storable_text(json.dumps(extra, default=str)).replace('\\u0000', '\\ufffd'))


MAX_LOG_MESSAGE_CHARS = 20_000


class SupabaseHandler(logging.Handler):
	"""Writes log records to v2_logs.

	Only backend services write logs, always with the service role: the table is
	operational evidence, so API clients cannot insert into it.
	"""

	def __init__(self):
		super().__init__()
		self.use_client = use_service_client

	def emit(self, record: logging.LogRecord) -> None:
		try:
			log_entry = {
				'name': record.name,
				'level': record.levelname,
				'message': storable_text(self.format(record), MAX_LOG_MESSAGE_CHARS),
				'origin': record.filename,
				'origin_line': record.lineno,
				'backend_version': __version__,
				'category': getattr(record, 'category', None),
				'user_id': getattr(record, 'user_id', None),
				'dataset_id': getattr(record, 'dataset_id', None),
				'extra': redact_extra(getattr(record, 'extra', None)),
			}

			with self.use_client() as client:
				client.table(settings.logs_table).insert(log_entry, returning='minimal').execute()

		except Exception as e:
			# Fallback to print if logging fails
			print(f'Error writing to v2_logs: {str(e)}')
			print(f'Failed log entry: {record.getMessage()}')


class UnifiedLogger(logging.Logger):
	def __init__(self, name: str):
		super().__init__(name)
		self.setLevel(logging.INFO)
		self.setup_logging()

	def setup_logging(self):
		if not self.handlers:
			# Console handler for all logs
			console_handler = logging.StreamHandler()
			console_formatter = logging.Formatter('%(asctime)s - [%(levelname)s] - %(name)s - %(message)s')
			console_handler.setFormatter(console_formatter)
			self.addHandler(console_handler)

			# Set base level to DEBUG in dev mode, INFO in production
			self.setLevel(logging.INFO if settings.DEV_MODE else logging.INFO)

	def _log_with_context(self, level: int, msg: str, context: LogContext, *args: Any, **kwargs: Any) -> None:
		if isinstance(context, LogContext):
			extra = {
				'category': context.category.value if context.category else None,
				'user_id': context.user_id,
				'dataset_id': context.dataset_id,
				'token': context.token,
				'extra': context.extra,
			}
			kwargs['extra'] = extra

		# Add small delay before any logging to ensure DB operations complete
		self.log(level, msg, *args, **kwargs)

	def info(self, msg: str, *args: Any, context: Optional[LogContext] = None, **kwargs: Any) -> None:
		# Handle both standard logging: info(msg, arg1, arg2) and custom: info(msg, context=LogContext)
		if context is None and args and len(args) > 0 and isinstance(args[0], LogContext):
			# Called as info(msg, LogContext_instance, ...)
			context = args[0]
			args = args[1:]
		self._log_with_context(logging.INFO, msg, context, *args, **kwargs)

	def error(self, msg: str, *args: Any, context: Optional[LogContext] = None, **kwargs: Any) -> None:
		# Handle both standard logging: error(msg, arg1, arg2) and custom: error(msg, context=LogContext)
		if context is None and args and len(args) > 0 and isinstance(args[0], LogContext):
			# Called as error(msg, LogContext_instance, ...)
			context = args[0]
			args = args[1:]
		self._log_with_context(logging.ERROR, msg, context, *args, **kwargs)

	def warning(self, msg: str, *args: Any, context: Optional[LogContext] = None, **kwargs: Any) -> None:
		# Handle both standard logging: warning(msg, arg1, arg2) and custom: warning(msg, context=LogContext)
		if context is None and args and len(args) > 0 and isinstance(args[0], LogContext):
			# Called as warning(msg, LogContext_instance, ...)
			context = args[0]
			args = args[1:]
		self._log_with_context(logging.WARNING, msg, context, *args, **kwargs)

	def debug(self, msg: str, *args: Any, context: Optional[LogContext] = None, **kwargs: Any) -> None:
		# Handle both standard logging: debug(msg, arg1, arg2) and custom: debug(msg, context=LogContext)
		if context is None and args and len(args) > 0 and isinstance(args[0], LogContext):
			# Called as debug(msg, LogContext_instance, ...)
			context = args[0]
			args = args[1:]
		self._log_with_context(logging.DEBUG, msg, context, *args, **kwargs)

	def add_supabase_handler(self, handler: SupabaseHandler) -> None:
		self.addHandler(handler)


# Register the custom logger class
logging.setLoggerClass(UnifiedLogger)


def get_logger(name: str) -> logging.Logger:
	"""Creates and returns a configured logger instance.

	Args:
	    name (str): The name for the logger, typically __name__

	Returns:
	    logging.Logger: Configured logger instance
	"""
	logger = logging.getLogger(name)

	if not logger.handlers:
		handler = logging.StreamHandler()
		formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
		handler.setFormatter(formatter)
		logger.addHandler(handler)
		logger.setLevel(logging.INFO)

	return logger


def log_with_context(logger: logging.Logger, level: int, message: str, extra: dict[str, Any] | None = None) -> None:
	"""Helper function to log messages with extra context.

	Args:
	    logger (logging.Logger): The logger instance
	    level (int): Logging level (e.g., logging.INFO)
	    message (str): The log message
	    extra (dict[str, Any] | None): Extra context to include in the log
	"""
	logger.log(level, message, extra=extra or {})
