import logging
from typing import Any


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
