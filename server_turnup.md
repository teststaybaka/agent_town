# Setup server

## VM
Create VM instance on Google Cloud with 2 vCPU and 8 GB RAM, enabling http interface.

SSH into it with tunneling: `gcloud compute ssh <instance-name> --zone <zone> -- -L 8123:localhost:8123`

## Install Docker
```Shell
# Remove unoffical packages
for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do sudo apt-get remove $pkg; done
# Add Docker's official GPG key:
sudo apt-get update
sudo apt-get install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update

# Install Docker
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

## Create dir
`mkdir mc && cd mc`

## Docker yaml

Create docker-compose.yml:

```yaml
services:
  mc:
    image: itzg/minecraft-server:latest
    container_name: mc-sim
    ports:
      - "25565:25565"   # minecraft
      - "8123:8123"     # dynmap web
    environment:
      EULA: "TRUE"
      TYPE: "PAPER"
      VERSION: "1.20.4"     # pin a version to match your mods/plugins
      MEMORY: "4G"
      ENABLE_RCON: "true"
      RCON_PASSWORD: "change-me"
      RCON_PORT: 25575
      ONLINE_MODE: "FALSE"  # if you’ll run bot clients without Mojang auth; keep TRUE for public servers
      # Optional: tweak game rules to suit “simulation” defaults
      # OPS: "your-minecraft-username"
      # DIFFICULTY: "hard"
      # VIEW_DISTANCE: 8
      # SIMULATION_DISTANCE: 8
    volumes:
      - ./data:/data
    restart: unless-stopped
```

## Run the first time
`sudo docker compose up` and kill it

## To observe using Dynmap
Go to https://www.spigotmc.org/resources/dynmap%C2%AE.274/ and download .jar  and upload to the server under `./data/plugins/` (uploading command: `gcloud compute scp <filename> <instance-name>:~/ --zone <zone>`)

## Restart Docker

Tunneling 8123 port: `gcloud compute ssh <instance-name> --zone <zone> -- -L 8123:localhost:8123`, and then start it: `sudo docker compose up`

## Render map

```Shell
sudo docker attach mc-sim
dynmap fullrender world
```

## Connect bot

Tunneling to connect from local: `gcloud compute ssh <instance-name> --zone <zone> -- -L 25565:localhost:25565`

## Make me a spectator

Run `docker exec mc-sim rcon-cli op eturnel2025` on VM's console. And run `/gamemode spectator` in game's chat, by pressing "T", and then double jump to start.
