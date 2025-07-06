# ddns porkbun update script

For any exposed ports attached to a domain name, this script will update the DNS records on Porkbun to point to the current public IP address of the machine.

## method

- runs on a cron job
- checks the current public IP address and compares to a cached last known IP address
- if the IP address has changed, it updates the DNS records on Porkbun and updates the cached last known IP address

## setup

- create `~/.config/ddns/` for config files
- `config` file contains `API_KEY`, `API_SECRET`, and `DOMAIN` (additionally `SUBDOMAIN` if you want to update a subdomain)
- TODO multiple domains support
- `last_ip` file contains the last known IP address
- `ddns.log` file contains the log of the script to tail for troubleshooting
- after script and config files are set up, run the script manually to ensure it works
- add a cron job to run the script every 15 minutes (or as desired)
- example cron job to `crontab -e`: `*/15 * * * * /path/to/ddns.sh >> /path/to/ddns.log 2>&1`
