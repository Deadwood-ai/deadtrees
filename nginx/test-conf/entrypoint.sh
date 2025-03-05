#!/bin/bash

# Create SSH directory if it doesn't exist
mkdir -p /root/.ssh
chmod 700 /root/.ssh

# Copy the public key from the mounted location to authorized_keys
if [ -f /tmp/ssh-keys/processing-to-storage.pub ]; then
    cp /tmp/ssh-keys/processing-to-storage.pub /root/.ssh/authorized_keys
    chown root:root /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
    echo "SSH key copied to authorized_keys"
else
    echo "Warning: SSH public key not found at /tmp/ssh-keys/processing-to-storage.pub"
fi

# Start SSH service and wait to ensure it's running
service ssh start
sleep 3  # Give SSH time to fully initialize

# Verify SSH is running and listening on port 22
ss -tuln | grep ":22 " || (echo "SSH not listening on port 22" && service ssh restart && sleep 2)

# Start nginx in foreground
nginx -g 'daemon off;' 