FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install nginx and SSH server in a single RUN
RUN apt-get update && \
    apt-get install -y nginx openssh-server && \
    mkdir -p /run/sshd && \
    mkdir -p /root/.ssh && \
    chmod 700 /root/.ssh && \
    # Remove default nginx site
    rm -f /etc/nginx/sites-enabled/default && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy your nginx configuration if needed
COPY conf /etc/nginx/conf.d/

# Expose ports
EXPOSE 80 22

# Start both nginx and sshd
CMD service ssh start && nginx -g 'daemon off;'