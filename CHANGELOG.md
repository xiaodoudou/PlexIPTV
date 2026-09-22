# Changelog

```
current work in progress:
 - investigating why buffer is failing on some specific IPTV vendor

1.6.0:
 - "sources" takes a list, so several Xtream accounts and playlist URLs can be
   combined into one lineup. The playlists are merged before parsing, so
   filters, renaming, channel numbers and the limit run once over the whole
   lineup and two providers cannot both claim the same channel number
 - one provider being unreachable no longer costs you the others: each is
   loaded on its own and a failure is named and skipped
 - guides are merged as well, each source bringing its own
 - a read only dashboard at /dashboard behind a password, showing what is
   playing, who is watching, the configured sources, recent warnings and
   errors and a log tail. The password is stored as an scrypt hash, and one is
   generated on first start and written to the console rather than the log
 - credentials no longer reach the log through the URLs ffmpeg quotes back in
   its diagnostics. Only credentials named in the settings file were scrubbed
   before, so a channel URL carrying its own was written out in clear
 - a channel now starts in about four seconds rather than twelve. Reaching the
   live edge meant delivering nothing until the next playlist refresh
 - a source that resolves but never sends video is given up on and the reason
   is shown as a video card, instead of leaving the player on an open socket
   that never receives a response
 - lint, tests on Node 22, 24 and 26, and a production dependency audit run on
   every push and pull request; a version tag builds the binaries and attaches
   them to the release

1.5.0:
 - an Xtream account can be configured with its url, username and password
   instead of a playlist URL. Channels, logos, guide ids and group names all
   come from the provider API, and the guide URL belongs to the account rather
   than being inferred
 - the account is checked at startup, so an expired or suspended line says so
   instead of appearing as an empty channel list
 - the provider's connection count is reported at startup
 - a channel name containing a line break can no longer inject an extra entry
   into the generated playlist

1.4.0:
 - serves an XMLTV guide at /xmltv.xml carrying the tvg-logo from your
   playlist, which is the only route by which a channel logo can reach Plex (#28)
 - merges provider programme data into it when there is any, keeping only the
   channels in your lineup and renumbering them to match
 - the guide URL is derived from an Xtream playlist URL automatically, or set
   "epgUrl" yourself
 - no guide, a broken guide or a slow one costs you programme listings and
   nothing else: the channels and their logos are served either way

1.3.1:
 - a filter that matches no channels now says so at startup, and offers the
   escaped pattern when the cause is an unescaped regex character. Four
   separate reports turned out to be this (#21, #22, #23, #27)

1.3.0:
 - RTSP channels (rtsp:// and rtsps://) now play, through ffmpeg with -c copy
   so nothing is re-encoded. Common on ISP boxes such as Freebox (#32)
 - an RTSP source that accepts the connection and then sends nothing is given
   up on after 15 seconds instead of holding the channel open
 - replaced node-ssdp with a small built-in SSDP responder. It was the last
   package pulling in a dependency with an unfixable advisory, and npm audit
   now reports zero vulnerabilities
 - discovery now degrades with a warning when port 1900 is already taken,
   rather than failing with an unhandled socket error
 - stream failures name the channel in the log rather than an internal URL

1.2.1:
 - fix: the upstream is now held open for a few seconds after the last viewer
   leaves, so a reconnecting player rejoins the running stream instead of
   restarting it. Restarting made the provider replay from the head of its
   buffer, which showed up as the channel looping back ten seconds, and on a
   one-connection line it also burned the only slot (#30)
 - fix: scan progress was a fraction floored to an integer, so it read 0%
   until the very last channel
 - fix: discover.json reported the model name in the ModelNumber field

1.2.0:
 - HLS (m3u8) streams are now supported: the playlist is followed and its
   segments are served to Plex as a continuous MPEG-TS stream (#8)
 - fragmented MP4 HLS segments are repackaged with ffmpeg (-c copy, no
   re-encoding); ffmpeg is optional and only needed for that case
 - a provider that answers with an error page and a 200 status is reported as
   a 502 naming the reason, instead of being streamed to Plex as if it were
   video (this is what "Unable to tune channel" usually was)
 - live HLS streams are joined at the live edge rather than replaying the
   playlist window

1.1.1:
 - fix: a filter matching several channels now numbers them consecutively
   instead of giving them all the same number (#21)
 - fix: a filter with no "channel" auto-numbers instead of producing the
   literal channel "undefined" (#21)
 - fix: a filter setting both "name" and "meta" never matched anything, so the
   combined form the README documents (and template.json ships) did not work
 - fix: a filter setting neither "name" nor "meta" claimed every channel; it is
   now ignored with a warning
 - docs: spell out that filters are regular expressions and need escaping (#27)

1.1.0:
 - security: stop writing provider credentials to the log file, settings and playlist cache
 - security: only fetch http/https URLs, and refuse private/loopback addresses by default
 - security: escape all values interpolated into device.xml
 - security: return 404 instead of faulting on an unknown channel id
 - security: drop request, lodash, moment, filendir and valid-url; upgrade the rest
 - security: Docker images run as a non-root user on Node 22 LTS
 - requires Node.js 18 or newer
 - adds a test suite (npm test)
 - BREAKING: streams on private/LAN addresses are now refused unless you set
   "allowPrivateNetwork": true in your settings
 
1.0.4:  
 - fix settings / template merging
 - add rename feature
 - add meta filtering

1.0.3:
 - allow config file path to be changed `--settings [path/file.json`
 - allow log path to be change through param `--logdir [path]`
 - add helper if app is called with `--help`
 - allow docker container to mount volume againts `/opt/PlexIPTV/config` to preserve config
 
1.0.2:
 - fix bug related to channel number was given as a int and not a string (require by plex)
 
1.0.1:
 - add option to avoid pulling online playlist
 - add a docker container

1.0.0:
 - first release

```
