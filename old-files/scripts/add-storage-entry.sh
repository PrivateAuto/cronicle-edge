#!/bin/sh

BASE=$(dirname $0)
KEY=$1
MATCH=$2
JSON=$3 

DIR="$(cd -- "$(dirname -- "$0")"; pwd)"
BIN="$(cd -- "${DIR}/../bin"; pwd)"

CLI="$BIN/storage-cli.js"
JEDIT="$DIR/jedit.js"

CNT=$($CLI get $KEY | jq -c .items[] | grep "\"${MATCH}\"")

if [ -z "$CNT" ] ; then
  echo "Adding entry to ${KEY}"
  $CLI get $KEY | $JEDIT --add items[]=${JSON} | jq | $CLI put $KEY
else
  echo "Entry ${MATCH} already listed in ${KEY}"
fi