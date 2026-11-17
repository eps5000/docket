#!/usr/bin/env bash
# A throwaway test CA and a certificate for the Jira fixture (jira-fixture.test), for the
# end-to-end tests only (docker/compose.jira-fixture.yaml). Writes docker/jira-fixture/certs/
# (git-ignored). The container trusts the CA through NODE_EXTRA_CA_CERTS; nothing else does.
#
#   docker/jira-fixture/make-certs.sh
set -euo pipefail
# Git Bash on Windows would rewrite the -subj values.
export MSYS_NO_PATHCONV=1

dir="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$dir"
cd "$dir"
if [ -s ca.pem ] && [ -s server.pem ] && [ -s server.key ] \
  && openssl x509 -checkend 3600 -noout -in server.pem >/dev/null 2>&1; then
  echo "Jira fixture certificates already in $dir"
  exit 0
fi
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Task Lite e2e test CA" \
  -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=jira-fixture.test" \
  -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:jira-fixture.test\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 30 \
  -extfile server.ext -out server.pem 2>/dev/null
rm -f server.csr server.ext ca.srl ca.key
# Readable by the containers' users (tasklite is uid 10001).
chmod 644 ca.pem server.pem server.key
echo "Jira fixture certificates written to $dir"
