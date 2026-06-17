# Media Seekbar

[![GNOME Extensions Version](https://img.shields.io/gnome-extensions/v/mediaseekbar@carlosjdelgado)](https://extensions.gnome.org/extension/REPLACE_ID/media-seekbar/)
[![GNOME Extensions Downloads](https://img.shields.io/gnome-extensions/dt/mediaseekbar@carlosjdelgado)](https://extensions.gnome.org/extension/REPLACE_ID/media-seekbar/)

GNOME Shell **48–50** extension that adds a progress (seek) bar with elapsed and
total time to the media controls in the date/notifications menu. Drag to seek on
players that support it via MPRIS (Spotify, browsers, mpv, VLC, etc.).

![Media Seekbar](screenshot.png)

It overrides `MediaMessage._update()` (via `InjectionManager`) to inject a bar
into each media message, reads duration/trackid/`CanSeek` from the player's MPRIS
proxy, polls `Position` once a second while playing, and calls `SetPosition`
(fallback `Seek`) on release. The bar hides for tracks with no duration (radios /
streams) and goes non-interactive when the player can't seek.
