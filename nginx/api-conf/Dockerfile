FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install nginx and SSH server in a single RUN
RUN apt-get update && \
    apt-get install -y nginx openssh-server && \
    mkdir -p /run/sshd && \
    mkdir -p /root/.ssh && \
    chmod 700 /root/.ssh && \
    # Configure sshd
    echo "PermitRootLogin yes" >> /etc/ssh/sshd_config && \
    echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config && \
    # Remove default nginx site
    rm -f /etc/nginx/sites-enabled/default && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy your nginx configuration if needed
COPY api-conf /etc/nginx/conf.d/
COPY api-conf/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose ports
EXPOSE 80 443 22


ENTRYPOINT ["/entrypoint.sh"]