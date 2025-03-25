# Docker Permission Issues

When setting up the processing server, encountered Docker permission issues. The following steps were taken to resolve:

## Installing Required Tools

First installed Supabase CLI using Homebrew:

# Install Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# add homebrew to path
...

# Install Supabase CLI
brew install supabase/tap/supabase


# install docker
sudo apt-get update

sudo apt install curl apt-transport-https ca-certificates software-properties-common 

echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt install docker-ce -y

then i could not run supabase 
because of a docker permission issue

sudo groupadd docker

sudo usermod -aG docker $USER

then i had to restart the docker service

ls -l /var/run/docker.sock

sudo chown root:docker /var/run/docker.sock

sudo systemctl restart docker

supabase start

sudo apt install python3-fire




First, check if Docker is running:
sudo systemctl status docker
2. If it's not running, start it:

sudo systemctl start docker
3. Add your user to the docker group (if not already done):
sudo usermod -aG docker $USER
Set the correct permissions for the Docker socket:
sudo chown root:docker /var/run/docker.sock
sudo chmod 666 /var/run/docker.sock
5. Create a systemd service to maintain these permissions across reboots. Create a new file:
sudo nano /etc/systemd/system/docker-socket-permission.service
Add the following content:

[Unit]
Description=Docker Socket Permission Fix
After=docker.service

[Service]
Type=oneshot
ExecStart=/bin/chmod 666 /var/run/docker.sock
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target

7. Enable and start the service:
sudo systemctl daemon-reload
sudo systemctl enable docker-socket-permission.service
sudo systemctl start docker-socket-permission.service

Log out and log back in for the group changes to take effect, or run:
newgrp docker


