#!/usr/bin/env bash
# Quick launcher for Venus 3D Interactive Web Server
cd "$(dirname "$0")"
echo "Launching Venus 3D Interactive Atlas..."
python3 app.py "$@"
