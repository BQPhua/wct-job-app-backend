# WCT daily reminders on the Ubuntu server: paste this whole block into the terminal.
# Runs the reminder job every day at 09:00 Malaysia time by calling the
# backend on this server directly, so it works without a public address
# (Power Automate in the cloud can't reach the office server).
ENVF=$(systemctl show -p EnvironmentFiles --value wct-backend | awk '{print $1}')
if [ -z "$ENVF" ] || ! sudo grep -q '^OFFBOARDING_CRON_SECRET=' "$ENVF"; then
  echo "STOP: add OFFBOARDING_CRON_SECRET=... to the backend environment file ($ENVF) first, then run: sudo systemctl restart wct-backend"
else
sudo tee /etc/systemd/system/wct-reminders.service > /dev/null <<WCT_EOF
[Unit]
Description=WCT daily reminder emails
After=wct-backend.service

[Service]
Type=oneshot
EnvironmentFile=$ENVF
ExecStart=/bin/sh -c 'curl -fsS -m 300 -X POST -H "x-cron-key: \${OFFBOARDING_CRON_SECRET}" http://localhost:3000/api/offboarding/cron/reminders; echo'
WCT_EOF
sudo tee /etc/systemd/system/wct-reminders.timer > /dev/null <<'WCT_EOF'
[Unit]
Description=Run WCT reminder emails every day at 09:00 MYT

[Timer]
OnCalendar=*-*-* 09:00:00 Asia/Kuala_Lumpur
Persistent=true

[Install]
WantedBy=timers.target
WCT_EOF
sudo systemctl daemon-reload && sudo systemctl enable --now wct-reminders.timer && echo "REMINDERS INSTALLED — next run:" && systemctl list-timers wct-reminders.timer --no-pager | sed -n 2p
fi
