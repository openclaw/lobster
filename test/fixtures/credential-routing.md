# Credential-routing fixtures

`credential-routing-2026.6.11.json` is the pipeline approval state emitted by
the published `@clawdbot/lobster` 2026.6.11 runtime for:

```text
approve --prompt Review | openclaw.invoke --tool demo --action read
```

The producer used a synthetic environment token and remote `OPENCLAW_URL`.
Neither is persisted in the state. Only JSON formatting is normalized. The test
installs these bytes in an isolated state directory and encodes a reference to
that state using the unchanged token format. It resumes through the built CLI
against a local TLS server and checks single dispatch and replay rejection.
The fixture exercises old serialized state, not an installed OpenClaw upgrade.

`credential-routing-test-key.pem` and `credential-routing-test-cert.pem` are a
**public test-only self-signed key/certificate pair**, not production credentials.
The certificate covers `gateway.test`. A child-process DNS-only preload maps this
test name to loopback without requiring external DNS or hosts-file changes.
The child test process trusts
only this additional certificate via `NODE_EXTRA_CA_CERTS`; certificate validation
is not disabled. Without it, the test requires the handshake to fail.

Regenerate both test-only PEM files together when required:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout test/fixtures/credential-routing-test-key.pem \
  -out test/fixtures/credential-routing-test-cert.pem \
  -days 3650 -subj /CN=gateway.test \
  -addext 'subjectAltName=DNS:gateway.test'
```
