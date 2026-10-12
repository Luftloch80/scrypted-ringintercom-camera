#!/bin/sh
# Installs the prebuilt Homebridge plugin from release/ into Homebridge, without building
# anything on the Raspberry Pi. Works with the Homebridge apt package (hb-service) and with
# the homebridge/homebridge Docker image.
#
# Usage:  sh install-homebridge-plugin.sh
set -e
cd "$(dirname "$0")"

TGZ=$(ls release/homebridge-ringintercom-reolink-*.tgz 2>/dev/null | sort -V | tail -1)
if [ -z "$TGZ" ]; then
    echo "Kein Paket in release/ gefunden. Bitte zuerst: git pull"
    exit 1
fi
FILE=$(basename "$TGZ")
echo "Installiere $FILE"

# Homebridge Docker container?
CONTAINER=$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '$2 ~ /homebridge\/homebridge/ {print $1; exit}')
if [ -n "$CONTAINER" ]; then
    echo "Homebridge läuft im Docker-Container $CONTAINER"
    docker cp "$TGZ" "$CONTAINER:/homebridge/$FILE"
    docker exec "$CONTAINER" sh -c "cd /homebridge && npm install --no-audit --no-fund ./$FILE && rm -f ./$FILE"
    docker restart "$CONTAINER"
    echo "Fertig. Homebridge wurde neu gestartet."
    exit 0
fi

# Homebridge apt package / hb-service
STORAGE=/var/lib/homebridge
if [ -d "$STORAGE" ]; then
    NODE_PATH_DIR=/opt/homebridge/bin
    sudo cp "$TGZ" "/tmp/$FILE"
    sudo chmod 644 "/tmp/$FILE"
    if id homebridge >/dev/null 2>&1; then
        sudo -u homebridge -H env PATH="$NODE_PATH_DIR:$PATH" sh -c "cd $STORAGE && npm install --no-audit --no-fund /tmp/$FILE"
    else
        sudo env PATH="$NODE_PATH_DIR:$PATH" sh -c "cd $STORAGE && npm install --no-audit --no-fund /tmp/$FILE"
    fi
    sudo rm -f "/tmp/$FILE"
    if command -v hb-service >/dev/null 2>&1; then
        sudo hb-service restart
        echo "Fertig. Homebridge wurde neu gestartet."
    else
        echo "Fertig. Bitte Homebridge neu starten."
    fi
    exit 0
fi

echo "Homebridge wurde nicht gefunden (weder /var/lib/homebridge noch ein homebridge/homebridge-Container)."
echo "Installation von Hand im Homebridge-Speicherordner:  npm install $(pwd)/$TGZ"
exit 1
