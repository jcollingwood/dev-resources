#!/bin/bash
# Porkbun DDNS Update Script

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Configuration
CONFIG_FILE="$HOME/.config/ddns/config"
LOG_FILE="$HOME/.config/ddns/ddns.log"
IP_CACHE_FILE="$HOME/.config/ddns/last_ip"
MAX_LOG_SIZE=1048576  # 1MB

# Function to log messages
log_message() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'): $1" >> "$LOG_FILE"
}

# Function to rotate log if too large
rotate_log() {
    if [[ -f "$LOG_FILE" && $(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null) -gt $MAX_LOG_SIZE ]]; then
        mv "$LOG_FILE" "${LOG_FILE}.old"
        log_message "Log rotated"
    fi
}

# Check if config exists
if [[ ! -f "$CONFIG_FILE" ]]; then
    log_message "ERROR: Config file not found at $CONFIG_FILE"
    exit 1
fi

# Source the config
source "$CONFIG_FILE"

# Validate required variables
if [[ -z "${API_KEY:-}" || -z "${SECRET_KEY:-}" || -z "${DOMAIN:-}" ]]; then
    log_message "ERROR: Missing required configuration (API_KEY, SECRET_KEY, or DOMAIN)"
    exit 1
fi

# Set default subdomain if not specified
SUBDOMAIN="${SUBDOMAIN:-@}"

# Rotate log if needed
rotate_log

# Get current public IP with multiple fallbacks
get_public_ip() {
    local ip=""
    local services=("ifconfig.me" "ipinfo.io/ip" "icanhazip.com" "checkip.amazonaws.com")

    for service in "${services[@]}"; do
        if ip=$(curl -s --connect-timeout 10 --max-time 30 "$service" 2>/dev/null); then
            # Validate IP format
            if [[ $ip =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
                echo "$ip"
                return 0
            fi
        fi
    done

    log_message "ERROR: Failed to get public IP from all services"
    exit 1
}

# Get current IP
CURRENT_IP=$(get_public_ip)
log_message "Current public IP: $CURRENT_IP"

# Check if IP has changed
if [[ -f "$IP_CACHE_FILE" ]]; then
    LAST_IP=$(cat "$IP_CACHE_FILE")
    if [[ "$CURRENT_IP" == "$LAST_IP" ]]; then
        log_message "IP unchanged, skipping update"
        exit 0
    fi
    log_message "IP changed from $LAST_IP to $CURRENT_IP"
else
    log_message "No cached IP found, proceeding with update"
fi

# Prepare API request
EDIT_API_URL="https://api.porkbun.com/api/json/v3/dns/editByNameType/$DOMAIN/A"
REQUEST="{\"secretapikey\":\"$SECRET_KEY\",\"apikey\":\"$API_KEY\",\"content\":\"$CURRENT_IP\"}"

# Make API request
response=$(curl -s --connect-timeout 10 --max-time 30 \
    -X POST "$EDIT_API_URL" \
    -H "Content-Type: application/json" \
    -d $REQUEST \
    2>/dev/null)

# Check if curl succeeded
if [[ $? -ne 0 ]]; then
    log_message "ERROR: Failed to connect to Porkbun API"
    exit 1
fi

# Parse response (basic check for success)
if echo "$response" | grep -q '"status":"SUCCESS"'; then
    log_message "SUCCESS: DNS record updated to $CURRENT_IP"
    echo "$CURRENT_IP" > "$IP_CACHE_FILE"
else
    log_message "ERROR: API request failed. Response: $response"
    exit 1
fi
