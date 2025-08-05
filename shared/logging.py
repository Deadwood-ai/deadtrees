import logging
import time
from typing import Any, Dict, Optional
from enum import Enum
import logfire
from shared.settings import settings
from shared.__version__ import __version__
from shared.db import use_client


class LogCategory(Enum):
	# API Operations
	UPLOAD = 'upload'  # File upload operations
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
	FOREST = 'forest'  # Forest cover analysis
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


class SupabaseHandler(logging.Handler):
	def __init__(self):
		super().__init__()
		self.use_client = use_client

	def emit(self, record: logging.LogRecord) -> None:
		try:
			token = None
			if hasattr(record, 'token'):
				token = record.token
			elif hasattr(record, 'extra') and isinstance(record.extra, dict):
				token = record.extra.get('token')

			# Build log entry
			log_entry = {
				'name': record.name,
				'level': record.levelname,
				'message': self.format(record),
				'origin': record.filename,
				'origin_line': record.lineno,
				'backend_version': __version__,
				'category': getattr(record, 'category', None),
				'user_id': getattr(record, 'user_id', None),
				'dataset_id': getattr(record, 'dataset_id', None),
				'extra': getattr(record, 'extra', None),
			}

			# Insert into v2_logs table
			with self.use_client(getattr(record, 'token', None)) as client:
				client.table(settings.logs_table).insert(log_entry).execute()

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

	def info(self, msg: str, context: Optional[LogContext] = None, *args: Any, **kwargs: Any) -> None:
		self._log_with_context(logging.INFO, msg, context, *args, **kwargs)

	def error(self, msg: str, context: Optional[LogContext] = None, *args: Any, **kwargs: Any) -> None:
		self._log_with_context(logging.ERROR, msg, context, *args, **kwargs)

	def warning(self, msg: str, context: Optional[LogContext] = None, *args: Any, **kwargs: Any) -> None:
		self._log_with_context(logging.WARNING, msg, context, *args, **kwargs)

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
