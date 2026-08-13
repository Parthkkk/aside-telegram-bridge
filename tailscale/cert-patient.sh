#!/bin/bash
export PATH=/opt/homebrew/bin:$PATH
TSDIR=$HOME/.aside-telegram-bridge/tailscale
# Resolved by the caller (setup.sh / build-android.sh). Failing here beats
# requesting a certificate for a hostname that is not this machine.
: "${ASIDE_TAILNET_HOST:?set ASIDE_TAILNET_HOST to this Mac's tailnet hostname}"
for i in $(seq 1 12); do
  # Two attempts close together: the second reuses the pending authz whose
  # TXT record has had time to reach Let's Encrypt's resolvers.
  /opt/homebrew/bin/tailscale --socket=$TSDIR/ts.sock cert \
    --cert-file=$TSDIR/tls.crt --key-file=$TSDIR/tls.key \
    "$ASIDE_TAILNET_HOST" >> $TSDIR/cert-patient.log 2>&1
  sleep 90
  if /opt/homebrew/bin/tailscale --socket=$TSDIR/ts.sock cert \
       --cert-file=$TSDIR/tls.crt --key-file=$TSDIR/tls.key \
       "$ASIDE_TAILNET_HOST" >> $TSDIR/cert-patient.log 2>&1; then
    echo "SUCCESS round $i $(date)" >> $TSDIR/cert-patient.log
    exit 0
  fi
  echo "round $i failed $(date)" >> $TSDIR/cert-patient.log
  sleep 700
done
