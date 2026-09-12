# Request diagnostics and retention

## What is implemented

Each API invocation gets a new cryptographically random 128-bit request ID. It is never derived from an IP, cookie, user, music link, or previous request. Caller-supplied request IDs are ignored. AsyncLocalStorage carries that ID through provider calls and asynchronous work within the request.

Responses include `X-Request-ID`. JSON error responses include the same value as `requestId`; the main app already displays that reference on failed requests. API responses use `Cache-Control: no-store` so caches do not share one request's reference with later visitors. Streamed/binary responses are preserved; `request.completed` means a response was created, not that the browser finished downloading it. Later streaming failures use that same request ID.

Logs contain only a timestamp, a reviewed event name, its configured severity, an optional HTTP status code, and an optional request ID. Provider operations such as lookup, fallback, and download failure remain visible. URLs, searches, music metadata, IPs, user agents, referrers, emails, feedback contents, Linear identifiers, credentials, raw exceptions, and upstream response bodies are not accepted as log fields. The central event catalog and runtime validation are both enforced; tests also reject raw server console calls and dynamic event names.

This is privacy-minimized diagnostic logging, not a promise of irreversible anonymity. A person can send their request ID to support, and someone with separate infrastructure records could potentially correlate timestamps. No cross-request visitor identifier is retained in application logs.

## Production storage

The Docker image starts `ops/start-private.mjs`. This launches Next.js with raw stdout/stderr discarded, accepts only validated IPC events, and stores sanitized JSONL files in `/app/logs`. This avoids accidental logging of framework exceptions and subprocess diagnostics. Development console output is not the production retention system; a bare `next start` or `node server.js` bypasses the supervisor.

The Compose configuration mounts a dedicated `yoink-logs` volume and disables Docker's logging driver for this service. GitHub Actions no longer copies request logs into deployment diagnostics.

Files use UTC dates. Each file is deleted seven days after the start of its date, so records normally remain for six to seven days. Cleanup runs on startup, before every accepted write, and every minute while the supervisor is running. An idle file can remain until the next minute's cleanup. Each day's file is capped at 5 MiB; new events are dropped when that day's cap is reached. The nominal retained capacity is 35 MiB.

The directory is created with mode 0700 and files with 0600. Storage or cleanup errors stop the supervised server rather than silently abandoning the retention rule. If the service or host is stopped, cleanup resumes at startup; physical deletion cannot run on a powered-off host. Exclude this volume from backups and log exports, or separately apply equivalent expiry to those copies.

## Debugging a report

Ask the reporter for the `req-…` reference shown by the app or returned in the response. On the deployed host, from the Compose project directory, use:

```sh
docker compose exec -T yoink node ops/find-request.mjs req-0123456789abcdef0123456789abcdef
```

Replace the example with the actual request ID. The command returns only matching, validated records and first removes expired files. It does not inspect or print request payloads. A missing result can mean the request never reached the app, retention expired, the daily cap was reached, or deployment has not adopted this configuration.

Raw exception text is intentionally unavailable. Improve missing diagnostics by adding a specific, fixed event to `src/lib/log-events.json` and calling `logEvent` at the relevant branch. An optional numeric HTTP status is supported. Do not add user-controlled context, hashes of personal data, raw error objects, or arbitrary strings.

## Infrastructure scope

Deploy the rebuilt image with the Compose configuration and verify a request-ID lookup after a deliberate validation failure. The non-root container user needs write access to the mounted log volume.

This retention policy covers the application's managed logs. Reverse-proxy, Cloudflare, host, backup, and older exported logs have separate settings. Configure those independently; this implementation does not sanitize or expire them.

Feedback follows the separate 90-day cleanup policy described on `/privacy`.

Reference: [Docker logging configuration](https://docs.docker.com/engine/logging/configure/).
