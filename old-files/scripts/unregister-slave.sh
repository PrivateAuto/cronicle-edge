#!/bin/sh

#
# see https://github.com/jhuckaby/Cronicle/discussions/479s
#

API_KEY=6bb74c4ce8395be5839f0afcfd4926eao
IP=$(hostname -i)

http://batch.paops.xyz/api/app/remove_server?api_key=${API_KEY}&hostname=${IP}

