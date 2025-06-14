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
API_URL="https://api.porkbun.com/api/json/v3/dns/retrieveByNameType/$DOMAIN/A"
BASE_REQUEST="{\"secretapikey\":\"$SECRET_KEY\",\"apikey\":\"$API_KEY\"}" 

EDIT_API_URL="https://api.porkbun.com/api/json/v3/dns/editByNameType/$DOMAIN/A"
REQUEST="{\"secretapikey\":\"$SECRET_KEY\",\"apikey\":\"$API_KEY\",\"content\":\"$CURRENT_IP\"}"

# retrieve existing record to check if update is needed
existing_response=$(curl -s --connect-timeout 10 --max-time 30 \
    -X GET "$API_URL" \
    -H "Content-Type: application/json" \
    -d $BASE_REQUEST \
    2>/dev/null)
if [[ $? -ne 0 ]]; then
    log_message "ERROR: Failed to connect to Porkbun API for retrieval"
    exit 1
fi
# Parse existing record
EXISTING_IP=$(echo "$existing_response" | jq -r '.data.content // empty')
if [[ "$EXISTING_IP" == "$CURRENT_IP" ]]; then
    log_message "Existing record already matches current IP: $EXISTING_IP"
    exit 0
fi

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
