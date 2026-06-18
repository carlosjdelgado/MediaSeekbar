# Media Seekbar

[![GNOME Extensions Version](https://img.shields.io/gnome-extensions/v/mediaseekbar@carlosjdelgado)](https://extensions.gnome.org/extension/10234/media-seekbar/)
[![GNOME Extensions Downloads](https://img.shields.io/gnome-extensions/dt/mediaseekbar@carlosjdelgado)](https://extensions.gnome.org/extension/10234/media-seekbar/)

GNOME Shell **48–50** extension that adds a progress (seek) bar with elapsed and
total time to the media controls in the date/notifications menu. Drag to seek on
players that support it via MPRIS (Spotify, browsers, mpv, VLC, etc.).

![Media Seekbar](screenshot.png)

It subscribes to MPRIS players on the session bus and attaches a seek bar to
each media message in the date/notifications menu. Duration, track id and
`CanSeek` are read from the player's MPRIS proxy; position is tracked from a
local monotonic clock between state changes, and `SetPosition` is called over
D-Bus on release. The bar hides for tracks with no duration (radios / streams)
and goes non-interactive when the player can't seek.
