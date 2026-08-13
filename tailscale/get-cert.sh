#!/bin/bash
# Retry the ACME cert until Let's Encrypt's failed-authorization window clears.
export PATH=/opt/homebrew/bin:$PATH
TSDIR=$HOME/.aside-telegram-bridge/tailscale
# Resolved by the caller (setup.sh / build-android.sh). Failing here beats
# requesting a certificate for a hostname that is not this machine.
: "${ASIDE_TAILNET_HOST:?set ASIDE_TAILNET_HOST to this Mac's tailnet hostname}"
for i in $(seq 1 25); do
  if /opt/homebrew/bin/tailscale --socket=$TSDIR/ts.sock cert \
       --cert-file=$TSDIR/tls.crt --key-file=$TSDIR/tls.key \
       "$ASIDE_TAILNET_HOST" >> $TSDIR/cert.log 2>&1; then
    echo "SUCCESS on attempt $i at $(date)" >> $TSDIR/cert.log
    exit 0
  fi
  echo "attempt $i failed at $(date)" >> $TSDIR/cert.log
  sleep 45
done
