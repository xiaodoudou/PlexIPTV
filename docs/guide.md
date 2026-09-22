# Channel logos and the guide

How logos and programme listings reach Plex.

Channel logos cannot travel through the tuner. PlexIPTV presents itself to Plex as an HDHomeRun device, and that lineup format has three fields per channel: number, name and URL. There is nowhere to put an image.

They travel through the **guide** instead, so PlexIPTV serves one:

```
http://your-server:1234/xmltv.xml
```

Add that as the XMLTV guide when you set up the DVR in Plex. It contains your channels, numbered and named exactly as the tuner presents them, with the `tvg-logo` from your playlist attached to each.

If your provider publishes an XMLTV feed, programme data is merged in as well. For an Xtream provider the URL is worked out from your playlist URL automatically, by swapping `get.php` for `xmltv.php`. Set `epgUrl` in the settings to point somewhere else, or to use a guide from a provider that does not follow that convention.

Only programmes for channels in your lineup are kept, and their channel ids are rewritten to your channel numbers. That matters for two reasons: pointing Plex straight at a provider guide stops working the moment you rename or renumber anything with filters, and a provider guide covering their whole catalogue runs to tens of megabytes where a filtered lineup needs well under a megabyte.

**None of this is required.** No guide URL, an unreachable one, or a provider without an EPG all produce the same thing: the channel list with its logos, served immediately. You lose programme listings and nothing else.

One thing worth knowing: logos served over plain `http` do not appear when you use Plex through `app.plex.tv`, because the browser refuses to load insecure images into a secure page. They show up in the local web app and in the native clients.
