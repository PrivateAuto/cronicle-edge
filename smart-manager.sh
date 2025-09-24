#!/bin/bash

# Smart manager startup script for Cronicle
# Checks if a manager already exists before forcing this container to be manager

HOMEDIR="$(dirname "$(cd -- "$(dirname "$(readlink -f "$0")")" && (pwd -P 2>/dev/null || pwd))")"

# Function to check if a manager already exists and is responding
check_existing_manager() {
    # Try to connect to storage and check if there are active servers
    if [ -f "$HOMEDIR/bin/storage-cli.js" ]; then
        echo "Checking for existing servers in storage..."

        # Get the list of servers from storage
        local servers_json=$(node "$HOMEDIR/bin/storage-cli.js" get global/servers/0 2>/dev/null)

        if [ $? -ne 0 ] || [ -z "$servers_json" ] || [ "$servers_json" = "null" ]; then
            echo "No servers found in storage or storage not accessible"
            return 1  # No servers found
        fi

        # Count servers
        local server_count=$(echo "$servers_json" | grep -c "hostname" || echo "0")

        if [ "$server_count" -eq 0 ]; then
            echo "No servers configured in storage"
            return 1  # No servers found
        fi

        echo "Found $server_count servers in storage, checking if any are alive..."

        # Extract hostnames and test connectivity
        # Parse JSON to get hostname:port combinations
        local alive_managers=0

        # Try to extract server info and ping each one
        # This is a simple approach - in a real environment you might want more sophisticated JSON parsing
        echo "$servers_json" | grep -o '"hostname":"[^"]*"' | cut -d'"' -f4 | while read hostname; do
            if [ -n "$hostname" ]; then
                echo "Testing connectivity to server: $hostname"

                # Get the web server port from config (default to 3012)
                local port=${CRONICLE_WebServer__http_port:-3012}

                # Test HTTP connectivity to the Cronicle web interface
                if command -v curl >/dev/null 2>&1; then
                    # Use curl to test the /api/app/status endpoint (should be available without auth)
                    if curl -s --connect-timeout 5 --max-time 10 "http://${hostname}:${port}/api/app/status" >/dev/null 2>&1; then
                        echo "✓ Server $hostname:$port is responding"
                        echo "1" > /tmp/cronicle_alive_check
                        return 0
                    else
                        echo "✗ Server $hostname:$port is not responding"
                    fi
                elif command -v wget >/dev/null 2>&1; then
                    # Fallback to wget
                    if wget -q --timeout=10 --tries=1 "http://${hostname}:${port}/api/app/status" -O /dev/null 2>/dev/null; then
                        echo "✓ Server $hostname:$port is responding"
                        echo "1" > /tmp/cronicle_alive_check
                        return 0
                    else
                        echo "✗ Server $hostname:$port is not responding"
                    fi
                else
                    # Fallback to basic TCP connection test using nc or telnet
                    if command -v nc >/dev/null 2>&1; then
                        if nc -z -w5 "$hostname" "$port" 2>/dev/null; then
                            echo "✓ Server $hostname:$port is accepting connections"
                            echo "1" > /tmp/cronicle_alive_check
                            return 0
                        else
                            echo "✗ Server $hostname:$port is not accepting connections"
                        fi
                    else
                        echo "⚠ Cannot test connectivity to $hostname:$port (no curl/wget/nc available)"
                        # If we can't test, assume server might be alive to be safe
                        echo "1" > /tmp/cronicle_alive_check
                        return 0
                    fi
                fi
            fi
        done

        # Check if any server responded
        if [ -f /tmp/cronicle_alive_check ]; then
            rm -f /tmp/cronicle_alive_check
            echo "Found at least one responding manager server"
            return 0  # Active manager found
        else
            echo "No servers are responding - all appear to be down"
            return 1  # No active manager found
        fi
    fi

    echo "Storage not accessible"
    return 1  # No manager found
}

# Check environment variable for explicit behavior
if [ "$CRONICLE_FORCE_MANAGER" = "1" ]; then
    echo "CRONICLE_FORCE_MANAGER=1 - forcing this container to be manager"
    exec "$HOMEDIR/bin/manager" --reset "$@"
elif [ "$CRONICLE_FORCE_WORKER" = "1" ]; then
    echo "CRONICLE_FORCE_WORKER=1 - starting as worker"
    exec "$HOMEDIR/bin/worker" "$@"
else
    # Smart decision based on existing infrastructure
    echo "Checking for existing Cronicle manager..."
    if check_existing_manager; then
        echo "Existing manager found - starting as worker"
        exec "$HOMEDIR/bin/worker" "$@"
    else
        echo "No existing manager found - becoming manager"
        exec "$HOMEDIR/bin/manager" --reset "$@"
    fi
fi