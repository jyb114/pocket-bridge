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

Forty-four isolated checks exercised the actual router and console functions:
strict source rejection, one in-flight dispatch, polling-safe buttons and clear
localized response failures. Seven adjacent regression suites also passed.

On Windows with the official native DSH 0.2.1-rc.2 host stopped, an actual
desktop Edge console click sent one local Start request. The button stayed
disabled while startup was pending. After about 32 seconds, the request returned
`dsh-start-complete`; the native application and its local backend were running,
and the console displayed the ready state and application-exit guidance.

After that cold start, the existing Cloudflare Quick HTTPS entrance was opened
in Edge at a phone viewport. Its connection had reached the retry limit during
the deliberate shutdown; clicking Retry restored the encrypted connection and
existing history. A newly submitted synthetic prompt received the requested
`PB17_COLD_START_OK` reply from the Flash model.

The [Preview.16 acceptance record](docs/PREVIEW16-ACCEPTANCE.md),
[compatibility matrix](docs/DSH-COMPATIBILITY.md) and
[manual acceptance record](docs/MANUAL-ACCEPTANCE.md) retain their original
versions and observations. They are historical evidence, not a new Preview.17
run. Preview.17's focused operations used a desktop Edge browser, including a
phone viewport, not a physical iPhone, Android handset or cellular network.
One current native host and Quick Tunnel run do not establish universal model,
network or cross-version compatibility. Existing releases are retained.
