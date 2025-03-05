#!/bin/bash
set -e

# Create SSH directory if it doesn't exist
mkdir -p /root/.ssh
chmod 700 /root/.ssh

# Copy SSH keys from mounted volume and set correct permissions
if [ -f /tmp/ssh-keys/processing-to-storage ]; then
  cp /tmp/ssh-keys/processing-to-storage /root/.ssh/
  chmod 600 /root/.ssh/processing-to-storage
fi

if [ -f /tmp/ssh-keys/processing-to-storage.pub ]; then
  cp /tmp/ssh-keys/processing-to-storage.pub /root/.ssh/
  chmod 644 /root/.ssh/processing-to-storage.pub
fi

# Execute the command passed to docker run
exec "$@" 