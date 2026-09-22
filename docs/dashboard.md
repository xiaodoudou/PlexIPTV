# Dashboard

A status page at `http://your-server:1234/dashboard`. It shows what is playing and, when something is not, why.

It is read-only. There are no buttons, nothing to click that could disturb a stream someone is watching.

## The password

There is no default password. On the first start, if none is set, PlexIPTV makes one up and prints it:

```
  PlexIPTV dashboard
  A password was generated because none was set.
  Password: fSwhfdeMc6amP2yjenUQ
  It is shown once, and only its hash is saved.
  Set dashboard.password in settings.json to choose your own.
```

That goes to the console and nowhere else. It is not written to `logs.txt`, because anyone who can read your logs could then read your dashboard. Only the hash lands in `settings.json`.

To pick your own, just type it into `settings.json`:

```javascript
{
  "dashboard": {
    "enabled": true,
    "password": "the-one-you-want",
    "refreshSeconds": 10
  }
}
```

Next start, it gets hashed in place and a warning tells you so. You never have to hash anything yourself.

`"enabled": false` turns the dashboard off.

## What is on it

- **Playing now**, one row per channel: number, name, how many people are watching, whether it is coming over `direct`, `hls` or `rtsp`, failures so far and the last upstream status
- **Sources**, and which of them loaded
- **Recent warnings and errors**, newest first, so a 458 or a dead channel is right there
- **Log**, the tail of `logs.txt`
- Channel count, viewers, uptime, version

The page reloads itself every `refreshSeconds`. The same data is at `/dashboard/status.json` if you would rather have JSON.

Stream URLs are redacted before they reach the page. Your subscription username and password are not rendered, even once you are logged in.

## It does not cover Plex

The password only guards `/dashboard`. Plex cannot log in, so `/device.xml`, `/lineup.json` and the channel URLs are open exactly as they always were. Putting a password in front of those would break the tuner.

So: the dashboard password protects the dashboard. It does not protect your streams. Keeping the server on a trusted network still matters, see [Security](security.md).

## Sessions

The session cookie is `HttpOnly` and `SameSite=Strict`, and carries its own expiry plus a signature. Nothing is kept server-side, so restarting PlexIPTV logs everyone out.

Ten wrong passwords from one address inside fifteen minutes and that address is locked out for the rest of the window.
