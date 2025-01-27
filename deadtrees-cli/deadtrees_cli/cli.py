#!/usr/bin/env python3
import fire
from typing import Optional, List

from .dev import DevCommands
from .data import DataCommands

class DeadtreesCLI:
    """Unified CLI tool for managing Deadwood API and development environment"""

    def __init__(self):
        self.dev = DevCommands()  # Development environment commands
        self.data = DataCommands()  # Data operations commands

    def __str__(self):
        return """Deadtrees CLI - A tool for managing Deadwood API

Available command groups:
  dev   - Development environment management
  data  - Data operations (upload, process, labels)

Example usage:
  deadtrees dev up                    # Start development environment
  deadtrees dev down                  # Stop development environment
  deadtrees data upload --help        # Show upload command help
"""

def main():
    fire.Fire(DeadtreesCLI)

if __name__ == "__main__":
    main() 