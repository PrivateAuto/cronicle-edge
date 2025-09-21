#!/bin/bash

echo "Altering systemd service to print logs without docker compose container name prefix..."

if [ -f /opt/elasticbeanstalk/config/private/eb-docker-compose-log-start ]; then
  # AWS Linux 2 >=v3.6.2
  sed 's/\(docker[ -]compose logs\) --since/\1 --no-log-prefix --since/' -i /opt/elasticbeanstalk/config/private/eb-docker-compose-log-start
else
  # # AWS Linux 2 <v3.6.2 && AWS Linux 2023 <=v4.0.1
  sed 's/\(docker[ -]compose logs\) -f/\1 --no-log-prefix -f/' -i /etc/systemd/system/eb-docker-compose-log.service
fi

systemctl daemon-reload


echo "Checking service status..."
STATUS=$(systemctl is-active eb-docker-compose-log.service)
echo "Status: [${STATUS}}"
if [ "$STATUS" == "active" ] ; then
  echo "docker-compose-log service is running. Restarting..."
  systemctl restart eb-docker-compose-log
else
  echo "docker-compose-log service is not running..."
fi

