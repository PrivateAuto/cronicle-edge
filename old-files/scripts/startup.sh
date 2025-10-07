#!/bin/sh

BIN=/opt/cronicle/bin
SCRIPT=/opt/cronicle/scripts
KEY="global/plugins/0"

CLI="$BIN/storage-cli.js"
CTL="$BIN/control.sh"
JEDIT="$SCRIPT/jedit.js"

$CTL setup
$CLI get global/server_groups/0 | $JEDIT --set items[0].regexp=".+" | $CLI put global/server_groups/0

for file in /opt/cronicle/plugins/*.ndjson; do
  ID=`cat $file | $JEDIT -g '.id'`
  echo "Checking plugin $ID registration..."

  CHK=`$CLI get global/plugins/0 | jq '.items[].id' | grep $ID`
  if [ -z "$CHK" ] ; then
    echo "Plugin ${ID} not found; adding..."
    $SCRIPT/add-storage-entry.sh $KEY $file @$file
    echo "-- Plugin added."
  else
    echo "-- Plugin ok."
  fi

done

$SCRIPT/register-server.sh

# for some reason the adds are not updating hte list header
$BIN/storage-repair.js 

$CTL start
