# Release notes - 1.0.0-preview.17

Start DSH from the desktop console through a strict local control request,
without requiring a phone authentication cookie. The request verifies the
loopback source and exact Host, Origin, protocol and gateway port.

HTTP failures and malformed responses now produce a clear failure message
instead of a JSON parsing error. Repeated requests share one in-flight start,
preventing duplicate DSH launches while startup is pending.

To close DSH, exit it from the DSH application. Pausing Pocket Bridge stops
phone access through that gateway; it does not close the DSH application.

## Validation scope

Targeted Preview.17 validation is pending. Record the focused local-control,
response-error and concurrent-start checks here after they have completed.

The [Preview.16 acceptance record](docs/PREVIEW16-ACCEPTANCE.md),
[compatibility matrix](docs/DSH-COMPATIBILITY.md) and
[manual acceptance record](docs/MANUAL-ACCEPTANCE.md) retain their original
versions and observations. They are historical evidence, not a new Preview.17
run. This console fix does not establish new physical-phone, public-tunnel,
model-provider or cross-version acceptance.
