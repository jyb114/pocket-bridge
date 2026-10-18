# Preview.17 acceptance

This is the historical focused acceptance record for 1.0.0-preview.17. It is
separate from the current release's layout and loading checks.

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

After the published Windows installer was downloaded and its SHA-256 verified,
the installed application retained the existing private state and received the
requested `PB17_INSTALLED_OK` reply through the HTTPS entrance. The focused
workspace-file Save operation downloaded the original 26-byte fixture with a
matching SHA-256 digest.

The [Preview.16 acceptance record](PREVIEW16-ACCEPTANCE.md),
[compatibility matrix](DSH-COMPATIBILITY.md) and
[manual acceptance record](MANUAL-ACCEPTANCE.md) retain the versions and
boundaries of their individual observations. These focused Preview.17 operations
used a desktop Edge browser, including a phone viewport, not a physical iPhone,
Android handset or cellular network. One current native host and Quick Tunnel
run do not establish universal model, network or cross-version compatibility.
