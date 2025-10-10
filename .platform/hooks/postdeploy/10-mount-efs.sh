#!/bin/bash
# Mount EFS to /opt/cronicle-data for persistent storage of logs, queue, and temp files

set -euo pipefail

EFS_ID="${EFS_ID:-}"
MOUNT_POINT="/opt/cronicle-data"

if [ -z "$EFS_ID" ]; then
  echo "EFS_ID not set, skipping EFS mount"
  exit 0
fi

echo "Mounting EFS $EFS_ID to $MOUNT_POINT"

# Create mount point if it doesn't exist
mkdir -p "$MOUNT_POINT"

# Check if already mounted
if mountpoint -q "$MOUNT_POINT"; then
  echo "EFS already mounted at $MOUNT_POINT"
else
  # Install NFS utilities if not present
  if ! command -v mount.nfs4 &> /dev/null; then
    echo "Installing nfs-utils..."
    yum install -y nfs-utils
  fi

  # Get availability zone for the EFS mount target
  REGION=$(ec2-metadata --availability-zone | cut -d " " -f 2 | sed 's/[a-z]$//')

  # Mount EFS using NFS4
  mount -t nfs4 -o nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport \
    "${EFS_ID}.efs.${REGION}.amazonaws.com:/" "$MOUNT_POINT"

  echo "EFS mounted successfully"
fi

# Create subdirectories with proper permissions
mkdir -p "$MOUNT_POINT/logs" "$MOUNT_POINT/logs/jobs" "$MOUNT_POINT/queue" "$MOUNT_POINT/tmp"
chown -R 2000:2099 "$MOUNT_POINT"
chmod -R 0775 "$MOUNT_POINT"

echo "EFS mount complete and directories created"
