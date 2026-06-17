# Media Seekbar

GNOME Shell **50** extension that adds a progress (seek) bar with elapsed and
total time to the media controls shown in the date/notifications menu. Drag to
seek within the track on players that support *seeking* via MPRIS (Spotify,
browsers, mpv with mpris, VLC, etc.).

## How it works

GNOME renders media controls as `MediaMessage` objects
(`js/ui/messageList.js`), one per detected MPRIS player. The extension:

1. Overrides `MediaMessage._update()` (via `InjectionManager`) to inject and
   sync a bar inside each media message.
2. Reads from the player's internal MPRIS proxy (`_playerProxy`):
   `Metadata['mpris:length']` (duration), `['mpris:trackid']` and `CanSeek`.
3. Polls `Position` once per second while the state is `Playing` (MPRIS does
   not notify position changes, so polling is required).
4. On slider release (or scroll/keyboard) calls `SetPosition`
   (fallback `Seek`) to jump.

The bar hides automatically when the track has no duration (e.g. radios /
streams) and becomes non-interactive when the player doesn't support *seeking*.

## Installation

```sh
ln -s "$PWD" \
  ~/.local/share/gnome-shell/extensions/mediaseekbar@carlosjdelgado
```

(or copy the folder instead of linking it).

Then enable the extension:

```sh
gnome-extensions enable mediaseekbar@carlosjdelgado
```

### Wayland note

On Wayland you **cannot** restart GNOME Shell in place. To load a freshly
installed extension you must **log out and back in**.

To iterate/develop without logging out, test in a nested shell:

```sh
dbus-run-session -- gnome-shell --nested --wayland
```

and enable the extension inside that nested session. Play something (e.g. open
a video in the browser or use `playerctl`) and open the date menu (clock in the
top panel) to see the bar below the controls.

## Debugging

```sh
journalctl -f -o cat /usr/bin/gnome-shell | grep -i seek
```

## Uninstall

```sh
gnome-extensions disable mediaseekbar@carlosjdelgado
rm ~/.local/share/gnome-shell/extensions/mediaseekbar@carlosjdelgado
```
