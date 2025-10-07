#!/bin/sh

BASE=$(dirname $0)

DIR="$(cd -- "$(dirname -- "$0")"; pwd)"
BIN="$(cd -- "${DIR}/../bin"; pwd)"

IP=$(hostname -i)
HOST=$(hostname)

KEY="global/servers/0"

CLI="$BIN/storage-cli.js"
JEDIT="$DIR/jedit.js"
JSON="{\"hostname\":\"${HOST}\", \"ip\":\"${IP}\" }" 


CNT=$($CLI get $KEY | jq -c .items[] | grep "\"${HOST}\"")

if [ -z "$CNT" ] ; then
  echo "Registering server in cluster"
  $CLI get $KEY | $JEDIT --add items[]="${JSON}" | jq | $CLI put $KEY
else
  echo "Server ${HOST} already listed in cluster"
fi
