// Media Seekbar — GNOME Shell 50
// Injects a seekbar with elapsed/total time into the media controls
// (MediaMessage) shown in the date menu. Position is polled because MPRIS
// doesn't notify Position changes; seeking uses SetPosition (or Seek).

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const POLL_INTERVAL_MS = 1000;   // position refresh while playing
const SEEK_DEBOUNCE_MS = 250;    // group scroll/keyboard before seeking

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

// Spec says 'mpris:length' is int64 ('x'), but some clients (Spotify) send
// uint64 ('t'); deepUnpack() handles both, then normalize to Number.
function variantToNumber(variant) {
    if (!variant)
        return 0;
    try {
        const value = variant.deepUnpack();
        return typeof value === 'bigint' ? Number(value) : Number(value) || 0;
    } catch (e) {
        return 0;
    }
}

function formatTime(micros) {
    if (!Number.isFinite(micros) || micros < 0)
        micros = 0;
    let secs = Math.floor(micros / 1_000_000);
    const hours = Math.floor(secs / 3600);
    secs -= hours * 3600;
    const mins = Math.floor(secs / 60);
    secs -= mins * 60;
    const pad = n => String(n).padStart(2, '0');
    return hours > 0
        ? `${hours}:${pad(mins)}:${pad(secs)}`
        : `${mins}:${pad(secs)}`;
}

const MediaSeekBar = GObject.registerClass(
class MediaSeekBar extends St.BoxLayout {
    _init(player) {
        super._init({
            style_class: 'media-seek-bar',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this._player = player;
        this._length = 0;          // microseconds
        this._lastPosition = 0;    // microseconds
        this._trackId = null;
        this._canSeek = false;
        this._dragging = false;
        this._settingValue = false;
        this._timerId = 0;
        this._seekTimeoutId = 0;
        this._cancellable = new Gio.Cancellable();

        this._positionLabel = new St.Label({
            style_class: 'media-seek-time',
            text: '0:00',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._slider = new Slider(0);
        this._slider.add_style_class_name('media-seek-slider');
        this._slider.x_expand = true;
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._durationLabel = new St.Label({
            style_class: 'media-seek-time',
            text: '0:00',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.add_child(this._positionLabel);
        this.add_child(this._slider);
        this.add_child(this._durationLabel);

        this._slider.connect('drag-begin', () => {
            this._dragging = true;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            this._seekToFraction(this._slider.value);
        });
        // Scroll and keyboard change the value without drag-begin/end.
        this._slider.connect('notify::value', () => {
            if (this._settingValue || this._dragging)
                return;
            this._queueSeek();
        });

        this._playerChangedId = this._player.connect('changed', () => this.sync());

        this.connect('destroy', this._onDestroy.bind(this));

        this.sync();
    }

    get _proxy() {
        return this._player?._playerProxy ?? null;
    }

    // Refresh duration, trackId, seek capability, visibility and polling.
    sync() {
        if (!this._player)
            return;

        const proxy = this._proxy;
        const meta = proxy?.Metadata ?? {};

        this._length = variantToNumber(meta['mpris:length']);

        const trackIdVariant = meta['mpris:trackid'];
        this._trackId = trackIdVariant ? trackIdVariant.deepUnpack() : null;

        // CanSeek isn't on the shell's proxy; read it over D-Bus directly.
        this._fetchCanSeek();

        const hasLength = this._length > 0;
        // No duration (radios/streams) means the bar makes no sense.
        this.visible = hasLength;
        // Slider reactivity is set in the _fetchCanSeek callback.
        this._durationLabel.text = formatTime(this._length);

        if (hasLength && this._player.status === 'Playing')
            this._startTimer();
        else
            this._stopTimer();

        // Refresh position immediately on state/track change.
        if (hasLength)
            this._fetchPosition();
    }

    _startTimer() {
        if (this._timerId)
            return;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            this._fetchPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    // Read a Player property over D-Bus. The shell's proxy only exposes a few
    // members, so Position/CanSeek and the seek methods aren't on it.
    _getPlayerProperty(prop, callback) {
        const proxy = this._proxy;
        if (!proxy)
            return;

        proxy.get_connection().call(
            proxy.get_name(),
            proxy.get_object_path(),
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, prop]),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (source, result) => {
                let reply;
                try {
                    reply = source.call_finish(result);
                } catch (e) {
                    // Cancelled on destroy, or the player went away: ignore.
                    return;
                }
                const [value] = reply.recursiveUnpack();
                callback(value);
            });
    }

    // Call a Player method over D-Bus (Seek/SetPosition aren't on the proxy).
    _callPlayerMethod(method, paramsVariant) {
        const proxy = this._proxy;
        if (!proxy)
            return;

        proxy.get_connection().call(
            proxy.get_name(),
            proxy.get_object_path(),
            PLAYER_IFACE,
            method,
            paramsVariant,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (source, result) => {
                try {
                    source.call_finish(result);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, `MediaSeekbar: ${method} failed`);
                }
            });
    }

    _fetchCanSeek() {
        this._getPlayerProperty('CanSeek', value => {
            this._canSeek = !!value;
            this._slider.reactive = this._canSeek;
            this._slider.can_focus = this._canSeek;
        });
    }

    // Read Position live (MPRIS omits it from PropertiesChanged).
    _fetchPosition() {
        this._getPlayerProperty('Position', value => {
            this._updatePosition(Number(value));
        });
    }

    _updatePosition(micros) {
        this._lastPosition = micros;
        this._positionLabel.text = formatTime(micros);

        if (this._dragging || this._length <= 0)
            return;

        this._settingValue = true;
        this._slider.value = clamp(micros / this._length, 0, 1);
        this._settingValue = false;
    }

    _queueSeek() {
        if (this._seekTimeoutId)
            GLib.source_remove(this._seekTimeoutId);
        this._seekTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEEK_DEBOUNCE_MS, () => {
            this._seekTimeoutId = 0;
            this._seekToFraction(this._slider.value);
            return GLib.SOURCE_REMOVE;
        });
    }

    _seekToFraction(fraction) {
        if (!this._canSeek || this._length <= 0)
            return;

        const target = Math.floor(clamp(fraction, 0, 1) * this._length);

        if (this._trackId) {
            // Absolute SetPosition(trackid, pos) avoids accumulating error.
            this._callPlayerMethod('SetPosition',
                new GLib.Variant('(ox)', [this._trackId, target]));
        } else {
            // Relative fallback when the trackid is unknown.
            this._callPlayerMethod('Seek',
                new GLib.Variant('(x)', [target - this._lastPosition]));
        }

        this._lastPosition = target;
        this._positionLabel.text = formatTime(target);
    }

    _onDestroy() {
        this._stopTimer();
        if (this._seekTimeoutId) {
            GLib.source_remove(this._seekTimeoutId);
            this._seekTimeoutId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._player && this._playerChangedId) {
            this._player.disconnect(this._playerChangedId);
            this._playerChangedId = 0;
        }
        this._player = null;
    }
});

export default class MediaSeekbarExtension extends Extension {
    enable() {
        this._seekBars = new Set();
        this._injectionManager = new InjectionManager();

        // MediaMessage calls _update() on build and on every player change;
        // ensure the seekbar exists and is synced there.
        this._injectionManager.overrideMethod(
            MessageList.MediaMessage.prototype, '_update',
            originalMethod => {
                const extension = this;
                return function (...args) {
                    originalMethod.call(this, ...args);
                    extension._ensureSeekBar(this);
                };
            });

        // Media messages that already existed before enabling.
        this._patchExistingMessages();
    }

    disable() {
        this._injectionManager?.clear();
        this._injectionManager = null;

        if (this._seekBars) {
            for (const seekBar of [...this._seekBars])
                seekBar.destroy();
            this._seekBars.clear();
            this._seekBars = null;
        }
    }

    _patchExistingMessages() {
        const messageView =
            Main.panel.statusArea.dateMenu?._messageList?._messageView;
        const playerToMessage = messageView?._playerToMessage;
        if (!playerToMessage)
            return;
        for (const message of playerToMessage.values())
            this._ensureSeekBar(message);
    }

    _ensureSeekBar(message) {
        if (!message?._player)
            return;

        if (message._mediaSeekBar) {
            message._mediaSeekBar.sync();
            return;
        }

        const seekBar = new MediaSeekBar(message._player);
        message._mediaSeekBar = seekBar;
        this._seekBars.add(seekBar);

        seekBar.connect('destroy', () => {
            this._seekBars?.delete(seekBar);
            if (message._mediaSeekBar === seekBar)
                message._mediaSeekBar = null;
        });

        // Insert just above the action area so the bar is always visible.
        const vbox = message.get_child?.();
        if (vbox && message._actionBin && vbox.contains(message._actionBin))
            vbox.insert_child_below(seekBar, message._actionBin);
        else if (vbox)
            vbox.add_child(seekBar);
        else
            message.setActionArea(seekBar);
    }
}
