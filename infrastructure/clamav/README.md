# ClamAV for TOUMA

Production: run `clamd` (e.g. the official `clamav/clamav` image) with `freshclam` updating the official signatures, then set:

```
MALWARE_SCANNER=clamav
CLAMAV_HOST=clamav
CLAMAV_PORT=3310
```

`StreamMaxLength`, `MaxFileSize` and `MaxScanSize` in `clamd.conf` must be at least `MEDIA_MAX_VIDEO_MB` (default 200 MB). Otherwise clamd refuses large videos, and TOUMA rejects them, because scanning fails closed.

## Test signatures (`test-signatures/`)
These match only the harmless **EICAR** antivirus test string: `.hdb` matches the exact file, and `.ndb` matches the string embedded anywhere, e.g. appended to a PNG. They let integration tests prove real detection without downloading the official database. Never use them as the only database in production.

`start-test-clamd.sh` starts a local clamd on 127.0.0.1:3310 with these signatures (used by the test suite and CI).
