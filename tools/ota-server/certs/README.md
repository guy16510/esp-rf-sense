# OTA server TLS material

This directory holds the TLS certificate and private key the OTA server presents to devices.
**Nothing in here except this README is committed** — see the repo `.gitignore`.

The device verifies the server certificate against an embedded root CA (the default, for a
local/self-hosted OTA endpoint) or against the public CA bundle (`esp_crt_bundle`) when the
manifest points at a public HTTPS host. The firmware never skips certificate validation.

## Local development root CA (recommended for a self-hosted server)

Generate a private root CA once, then issue a server certificate for the OTA host. Replace
`rf-sense-ota.local` with the hostname (or IP via a SAN) the device will actually connect to —
the SAN **must** match, or the device's TLS handshake fails (by design).

```bash
# 1) Root CA (keep ca.key offline / out of the repo)
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
  -keyout ca.key -out ca.crt -subj "/CN=RF-Sense Local Root CA"

# 2) Server key + CSR
openssl req -newkey rsa:2048 -nodes \
  -keyout server.key -out server.csr -subj "/CN=rf-sense-ota.local"

# 3) Sign the server cert with a matching SAN
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 825 -out server.crt \
  -extfile <(printf "subjectAltName=DNS:rf-sense-ota.local,IP:192.168.1.10")
```

Then point the firmware at the CA by replacing
`firmware/components/ota_manager/certs/ota_root_ca.pem` with `ca.crt` (rebuild + reflash via a
bootstrap flash, since the trusted root is compiled in), and start the server with:

```bash
RF_SENSE_TLS_CERT=tools/ota-server/certs/server.crt \
RF_SENSE_TLS_KEY=tools/ota-server/certs/server.key \
RF_SENSE_OTA_ROOT=dist/ota \
npm run ota-server:start
```

## Public HTTPS endpoint

If you serve OTA from a public host with a publicly-trusted certificate, you do not need to embed
a private root: build the firmware with the certificate-bundle path and host the files behind any
standard TLS terminator. The manifest `firmwareUrl` must be `https://`.
