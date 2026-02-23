#!/bin/bash

# This container is an SSH *server* endpoint for storage access.
# It should not generate client keys (and cannot, because /root/.ssh is mounted read-only).
if [ ! -f /root/.ssh/authorized_keys ]; then
	echo "Warning: /root/.ssh/authorized_keys not found; SSH public key auth may fail."
fi

# Start SSH service
service ssh start
echo "SSH service started"

# Start nginx in foreground
echo "Starting nginx..."
nginx -g 'daemon off;' 