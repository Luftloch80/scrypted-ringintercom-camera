#!/bin/sh
# Installs the prebuilt plugin (release/plugin.zip) on a Scrypted server without
# building it locally. Building needs a lot of RAM and can freeze a Raspberry Pi.
#
# Usage:  sh deploy-prebuilt.sh [scrypted-ip]      (default: 127.0.0.1)
# Requires a previous "npx scrypted login <ip>" (stored in ~/.scrypted/login.json).
set -e
cd "$(dirname "$0")"

HOST="${1:-127.0.0.1}"
case "$HOST" in *:*) ;; *) HOST="$HOST:10443" ;; esac

LOGIN="$HOME/.scrypted/login.json"
if [ ! -f "$LOGIN" ]; then
    echo "Nicht angemeldet. Bitte zuerst: npx scrypted login ${1:-127.0.0.1}"
    exit 1
fi

CREDS=$(python3 -c "import json,sys; l=json.load(open(sys.argv[1])).get(sys.argv[2]) or {}; print(l.get('username','') + ':' + l.get('token',''))" "$LOGIN" "$HOST")
if [ "$CREDS" = ":" ]; then
    echo "Kein Login für $HOST gefunden. Bitte zuerst: npx scrypted login ${1:-127.0.0.1}"
    exit 1
fi

PKG="@luftloch80/scrypted-ringintercom-camera"
echo "deploying release/plugin.zip to $HOST"
curl -fsSk -u "$CREDS" -H 'Content-Type: application/json' --data-binary @package.json \
    "https://$HOST/web/component/script/setup?&npmPackage=$PKG" > /dev/null
curl -fsSk -u "$CREDS" -H 'Content-Type: application/zip' --data-binary @release/plugin.zip \
    "https://$HOST/web/component/script/deploy?&npmPackage=$PKG" > /dev/null
echo "deployed to $HOST"
