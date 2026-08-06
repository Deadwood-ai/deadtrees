#!/bin/bash

set -euo pipefail

require_root() {
	if [ "$(/usr/bin/id -u)" -ne 0 ]; then
		echo "processor_snap_control.sh must run as root" >&2
		exit 1
	fi
}

case "${1:-}" in
	hold)
		if [ "$#" -ne 2 ]; then
			echo "hold requires exactly one duration" >&2
			exit 2
		fi
		duration="${2:-}"
		if ! [[ "${duration}" =~ ^[1-9][0-9]*[smh]$ ]]; then
			echo "Hold duration must be a positive integer followed by s, m, or h" >&2
			exit 2
		fi
		require_root
		exec /usr/bin/snap refresh --hold="${duration}" docker
		;;
	refresh)
		if [ "$#" -ne 1 ]; then
			echo "refresh does not accept arguments" >&2
			exit 2
		fi
		require_root
		exec /usr/bin/snap refresh docker
		;;
	*)
		echo "Usage: processor_snap_control.sh hold DURATION | refresh" >&2
		exit 2
		;;
esac
