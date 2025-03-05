#!/bin/bash

# Generate SSH key pair if it doesn't exist
if [ ! -f /root/.ssh/id_rsa ]; then
    ssh-keygen -t rsa -b 4096 -f /root/.ssh/id_rsa -N ""
    cp /root/.ssh/id_rsa.pub /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/id_rsa
    chmod 644 /root/.ssh/id_rsa.pub /root/.ssh/authorized_keys
fi

# Start services
service ssh start
nginx -g 'daemon off;' 