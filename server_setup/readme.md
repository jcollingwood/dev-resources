# server configuration stuff

## first steps

### ssh tweaks

in a nutshell, setting up ssh keys with non-root user and disabling root login

```bash
# create a new user
adduser myuser

# add the user to the sudo group
usermod -aG sudo myuser

# view groups
groups myuser
```

from your local machine:

```bash
# generate ssh keys if you don't have them already
ssh-copy-id myuser@your_server_ip
```

then on the server:

```bash
# edit the ssh config file
vim /etc/ssh/sshd_config
# find and change the following lines
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
# save and exit
# restart ssh service
sudo systemctl restart sshd
sudo systemctl status sshd
```

### updates

```bash
sudo apt update && sudo apt upgrade -y
```

### fail2ban
```
# fail2ban stuff
sudo apt install fail2ban
# create local config file
sudo cp /etc/fail2ban/jail.conf /etc/fail2ban/jail.local
# edit the local config file
sudo vim /etc/fail2ban/jail.local
```

update config file:

```
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 3

[sshd]
enabled = true
port = 2222
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600
```

then restart fail2ban:

```bash 
sudo systemctl start fail2ban
# to start on reboot
sudo systemctl enable fail2ban
sudo systemctl restart fail2ban
sudo systemctl status fail2ban
```

### upgrades

```bash
# Install unattended-upgrades
sudo apt install unattended-upgrades

# Configure automatic updates
sudo dpkg-reconfigure -plow unattended-upgrades

# Edit configuration if needed
sudo nano /etc/apt/apt.conf.d/50unattended-upgrades
```

### firewall

TODO clean up docs
```bash 
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status
```

