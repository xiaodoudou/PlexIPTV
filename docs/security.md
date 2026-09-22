# Security

What the app does to keep your subscription and your network safe.

Two points matter when you deploy:

**The server has no authentication.** It binds `0.0.0.0` by default so Plex can
discover it on your LAN, which means anyone who can reach the port can list and
stream every channel using your subscription. Keep it on a trusted network, or
set `"serverHost"` to a specific interface. Do not port-forward it.

**Streams pointing at private addresses are refused by default.** Only `http`
and `https` URLs are fetched, and addresses in private, loopback, link-local
and reserved ranges are rejected so a hostile or tampered playlist cannot turn
the proxy into a probe against your internal network. If you genuinely stream
from a LAN source, set `"allowPrivateNetwork": true`.
