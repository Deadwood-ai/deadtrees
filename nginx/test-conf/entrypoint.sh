#!/bin/bash

# Create SSH directory if it doesn't exist
mkdir -p /root/.ssh
chmod 700 /root/.ssh

# Make sure authorized_keys has the right permissions
if [ -f /root/.ssh/authorized_keys ]; then
    chmod 600 /root/.ssh/authorized_keys
fi

# Start services
service ssh start
nginx -g 'daemon off;' 