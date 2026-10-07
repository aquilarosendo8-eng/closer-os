# Supabase PostgreSQL CA

`supabase-root-2021.crt` is the public Supabase Root 2021 CA, downloaded over
verified HTTPS from Supabase's distribution endpoint:

https://supabase-downloads.s3.amazonaws.com/prod/ssl/prod-ca-2021.crt

Supabase documents this certificate and recommends full chain/hostname
verification at https://supabase.com/docs/guides/platform/ssl-enforcement.

SHA-256 certificate fingerprint:
`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`

Valid until 2031-04-26. The provisioning script extends the system roots with
this certificate and keeps `rejectUnauthorized: true`. `CLOSER_DB_CA_FILE` can
point to a replacement certificate obtained from the project's official
dashboard when the provider rotates the CA. Never disable TLS verification.
This file is a public trust certificate, not a private key or credential.
