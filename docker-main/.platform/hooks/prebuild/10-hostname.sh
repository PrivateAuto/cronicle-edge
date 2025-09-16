#!/usr/bin/env bash

exit \0

set -euo pipefail
APP_DIR="/var/app/staging"
ENV_FILE="$APP_DIR/.env"

TOKEN=`curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300"`
NEW_HOSTNAME=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-hostname || echo "")
if [ -n "$NEW_HOSTNAME" ]; then
  hostname $NEW_HOSTNAME
  # Ensure .env exists (Beanstalk usually generates it already)
  touch "$ENV_FILE"
  # Add/replace CRONICLE_HOSTNAME
  grep -q '^CRONICLE_HOSTNAME=' "$ENV_FILE" \
    && sed -i "s/^CRONICLE_HOSTNAME=.*/CRONICLE_HOSTNAME=$NEW_HOSTNAME/" "$ENV_FILE" \
    || echo "CRONICLE_HOSTNAME=$NEW_HOSTNAME" >> "$ENV_FILE"
fi
