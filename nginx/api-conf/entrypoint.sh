#!/bin/bash

# Generate SSH key pair if it doesn't exist
if [ ! -f /root/.ssh/id_rsa ]; then
    ssh-keygen -t rsa -b 4096 -f /root/.ssh/id_rsa -N ""
    cp /root/.ssh/id_rsa.pub /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/id_rsa
    chmod 644 /root/.ssh/id_rsa.pub /root/.ssh/authorized_keys
    echo "Generated new SSH keys"
else
    echo "Using existing SSH keys"
fi

# Print the public key for reference
echo "SSH public key for authentication:"
cat /root/.ssh/id_rsa.pub

# Start SSH service
service ssh start
echo "SSH service started"

# Start nginx in foreground
echo "Starting nginx..."
nginx -g 'daemon off;' 