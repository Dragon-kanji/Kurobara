# Operations and privacy

Kurobara handles provider credentials, durable state, and potentially personal
contact data. Run it as a private service unless you have designed and reviewed
the missing Internet-facing controls.

## Network posture

- The API binds to `127.0.0.1` by default.
- A non-loopback host requires `KUROBARA_ALLOW_NON_LOOPBACK=true`.
- The tracked Compose profile keeps Hatchet internal and uses its
  auth-disabled image only for local qualification.
- The preview does not claim production hardening or a supported hosted setup.

## Secrets

Keep these outside Git:

- Kurobara API keys;
- provider keys;
- PostgreSQL credentials;
- Hatchet tokens;
- contact privacy HMAC keys;
- contact export policies when they contain private business context.

Prefer private files or a secret manager. Do not place credentials in prompts,
CLI arguments, screenshots, support requests, or logs.

## Contact privacy keyring

Selected contact operations require a stable HMAC configuration shared by the
API and worker. Prefer `KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON` with one
current key and retained historical keys:

```json
[
  {
    "current": false,
    "secret": "synthetic-do-not-use-contact-hmac-key-v1-000000",
    "version": "v1"
  },
  {
    "current": true,
    "secret": "synthetic-do-not-use-contact-hmac-key-v2-000000",
    "version": "v2"
  }
]
```

Each secret must be at least 32 bytes. Do not remove an old version until a
readback proves that no active tombstone or delivery link depends on it.

Legacy single-key variables remain accepted, but they must not be combined with
the keyring.

## Contact exports

A generated contact dataset requires:

- `datasets:export` and `contacts:export`;
- an explicit server-side `KUROBARA_CONTACT_EXPORT_POLICY_JSON`;
- provider-rights entries matching the dataset lineage;
- a bounded retention period;
- a stable privacy keyring.

The effective expiry is the strictest applicable policy or provider limit.
Export receipts can be read with `dataset export-status` and revoked with
`dataset export-revoke`.

The configuration is server-owned, not supplied by a CLI request. This
synthetic example shows the required shape for the Prospeo path:

```json
{
  "policy_version": "local-contact-export-v1",
  "purpose_ref": "authorized-b2b-export",
  "territory": "ES",
  "policy_ttl_ms": 3600000,
  "max_retention_ms": {
    "contact-identity": 86400000,
    "employment": 86400000,
    "professional-social-profile": 86400000,
    "professional-email": 86400000
  },
  "provider_rights": {
    "prospeo-person-search": {
      "mode": "operator-authorized-byok",
      "ttl_ms": 3600000,
      "version": "operator-policy-v1"
    }
  }
}
```

Set the serialized object as `KUROBARA_CONTACT_EXPORT_POLICY_JSON` in the API
environment only after adapting it to your actual policy and provider rights.
The example is a schema demonstration, not legal advice or a grant of rights.

Revocation prevents future use by Kurobara. It cannot recall a file that has
already been copied elsewhere.

## Subject restriction

`contact restrict` records an email or provider-subject tombstone before
propagating the restriction to related deliveries. Supply values through
`--value-file`, not a command argument.

Use only for an authorized operator request, provider deletion, provider
opt-out, or subject request. The command is not a substitute for your wider
privacy process.

## Backup and restore

The self-host scripts operate on the configured application database:

```sh
deploy/self-host/backup.sh /absolute/path/to/private-backups
```

Restore is destructive and requires explicit confirmation:

```sh
deploy/self-host/restore.sh \
  --confirm /absolute/path/to/private-backups/kurobara-<timestamp>.dump
```

The restore stops the API and worker, restores atomically, and restarts them
only after success. Keep the dump private and use PostgreSQL client tools with
the same major version as the server.

## Release artifacts

Preview releases include checksums, a release manifest, a source archive, a CLI
tarball, runtime bundles, and CycloneDX SBOMs.

Verify a downloaded release directory before use:

```sh
shasum --algorithm 256 --check SHA256SUMS
```

The manifest binds artifacts to a Git commit and tree. Verify the repository
release page and commit signature separately.

## Incident handling

- Suspected vulnerability: follow [SECURITY.md](../SECURITY.md).
- Non-sensitive bug: follow [SUPPORT.md](../SUPPORT.md).
- Unexpected personal data: stop the run, preserve minimal evidence, restrict
  the affected subject when authorized, and do not paste the payload into a
  public issue.
