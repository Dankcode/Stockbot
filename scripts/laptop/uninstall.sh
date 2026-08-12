#!/bin/bash
set -euo pipefail

label="com.stockbot.laptop"
domain="gui/$(id -u)"
plist_path="${HOME}/Library/LaunchAgents/${label}.plist"
if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
  /bin/launchctl bootout "$domain/$label"
fi
if [[ -f "$plist_path" ]]; then /bin/rm "$plist_path"; fi
echo "Stockbot LaunchAgent removed. Database, config, logs, and Tailscale Serve configuration were preserved."
echo "To disable only Stockbot's Tailscale root endpoint, run: tailscale serve --https=443 off"
