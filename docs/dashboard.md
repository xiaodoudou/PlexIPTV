# Dashboard

A read-only status page at `/dashboard`, showing what is playing and why
anything is not.

```
http://your-server:1234/dashboard
```

## The password

There is no default password, and the dashboard is never left open.

On the first start with no password set, one is generated and printed to the
console:

```
  PlexIPTV dashboard
  A password was generated because none was set.
  Password: fSwhfdeMc6amP2yjenUQ
  It is shown once, and only its hash is saved.
  Set dashboard.password in settings.json to choose your own.
```

It goes to the console only, never to `logs.txt`, because the log file is not
access controlled. Only an scrypt hash of it reaches `settings.json`. It is
also registered with the logger, so it is scrubbed if it ever turns up in a log
line.

To choose your own, put it in `settings.json` in plain text:

```javascript
{
  "dashboard": {
    "enabled": true,
    "password": "the-one-you-want",
    "refreshSeconds": 10
  }
}
```

On the next start it is replaced in place with its hash, and a warning says so.
You never have to hash anything yourself.

Set `enabled` to `false` to switch the dashboard off entirely.

## What it shows

- **Playing now**: every active channel with its number, name, viewer count,
  transport (`direct`, `hls` or `rtsp`), consecutive failures and last upstream
  status
- **Sources**: each configured provider, its type, and whether it loaded
- **Recent warnings and errors**: the last fifteen, newest first, so a 458 or a
  dead channel is visible without reading the log
- **Log**: the tail of `logs.txt`
- Channel count, total viewers, uptime, version and Node version

The page refreshes itself every `refreshSeconds`. There is also
`/dashboard/status.json`, behind the same password, carrying the same data.

## What it deliberately does not do

It only reads. It never subscribes to a worker, never writes and has no
controls, so nothing on the page can disturb a stream someone is watching.

Upstream URLs are redacted before they reach the page, so a subscription URL
carrying a username and password is never rendered, even to a logged-in
viewer.

## Plex is not affected

Authentication covers the dashboard path only. Plex cannot log in, so
`/device.xml`, `/discover.json`, `/lineup.json`, `/lineup_status.json` and the
channel URLs stay open exactly as before. Putting a password in front of those
would simply break the tuner.

This means the dashboard password protects the dashboard, not the streams. The
advice in [Security](security.md) about keeping the server on a trusted network
still applies.

## Sessions

A session is its own expiry plus a signature over it, held in an `HttpOnly`,
`SameSite=Strict` cookie. Nothing is stored on the server, so restarting the
app signs everyone out.

Ten failed logins from one address in fifteen minutes blocks further attempts
from it for the rest of that window.
