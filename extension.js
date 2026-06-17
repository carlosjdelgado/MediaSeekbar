// Media Seekbar — GNOME Shell 48–50
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

// 'mpris:length' is int64 ('x') per spec but some clients (Spotify) send
// uint64 ('t'); deepUnpack() handles both (bigint or number).
function variantToNumber(variant) {
    try {
        return Number(variant?.deepUnpack()) || 0;
    } catch (e) {
        return 0;
    }
}

function formatTime(micros) {
    const t = Math.max(0, Math.floor(micros / 1_000_000)) || 0;
    const pad = n => String(n).padStart(2, '0');
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const MediaSeekBar = GObject.registerClass(
class MediaSeekBar extends St.BoxLayout {
    // Live bars, so disable() can tear them all down.
    static _instances = new Set();

    // Create (or just sync) the bar that belongs to a media message.
    static ensureOn(message) {
        if (!message?._player)
            return;
        if (message._mediaSeekBar) {
            message._mediaSeekBar.sync();
            return;
        }
        message._mediaSeekBar = new MediaSeekBar(message);
    }

    // Media messages that already existed before the extension was enabled.
    static patchExisting() {
        const playerToMessage =
            Main.panel.statusArea.dateMenu?._messageList?._messageView?._playerToMessage;
        if (!playerToMessage)
            return;
        for (const message of playerToMessage.values())
            MediaSeekBar.ensureOn(message);
    }

    static destroyAll() {
        for (const bar of [...MediaSeekBar._instances])
            bar.destroy();
    }

    _init(message) {
        super._init({
            style_class: 'media-seek-bar',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this._message = message;
        this._player = message._player;
        this._length = 0;          // microseconds
        this._lastPosition = 0;    // microseconds
        this._trackId = null;
        this._canSeek = false;
        this._dragging = false;
        this._settingValue = false;
        this._timerId = 0;
        this._seekTimeoutId = 0;
        this._cancellable = new Gio.Cancellable();
        MediaSeekBar._instances.add(this);

        const timeLabel = xAlign => new St.Label({
            style_class: 'media-seek-time', text: '0:00',
            x_align: xAlign, y_align: Clutter.ActorAlign.CENTER,
        });
        this._positionLabel = timeLabel(Clutter.ActorAlign.START);
        this._slider = new Slider(0);
        this._slider.add_style_class_name('media-seek-slider');
        this._slider.x_expand = true;
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._durationLabel = timeLabel(Clutter.ActorAlign.END);

        this.add_child(this._positionLabel);
        this.add_child(this._slider);
        this.add_child(this._durationLabel);

        // Scroll and keyboard change the value without drag-begin/end.
        this._slider.connectObject(
            'drag-begin', () => {
                this._dragging = true;
            },
            'drag-end', () => {
                this._dragging = false;
                this._seekToFraction(this._slider.value);
            },
            'notify::value', () => {
                if (this._settingValue || this._dragging)
                    return;
                this._queueSeek();
            },
            this);

        this._player.connectObject('changed', () => this.sync(), this);

        this._attach(message);
        this.sync();
    }

    // Insert just above the action area so the bar is always visible.
    _attach(message) {
        const vbox = message.get_child?.();
        if (vbox && message._actionBin && vbox.contains(message._actionBin))
            vbox.insert_child_below(this, message._actionBin);
        else if (vbox)
            vbox.add_child(this);
        else
            message.setActionArea(this);
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

    // Raw D-Bus call: the shell's proxy lacks Position/CanSeek/Seek/SetPosition.
    // Errors are ignored (cancelled on destroy, or the player went away).
    _dbus(iface, method, params, replyType, onReply) {
        const proxy = this._proxy;
        if (!proxy)
            return;
        proxy.get_connection().call(
            proxy.get_name(), proxy.get_object_path(), iface, method, params,
            replyType, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (source, result) => {
                try {
                    onReply?.(source.call_finish(result));
                } catch (e) {}
            });
    }

    _getPlayerProperty(prop, callback) {
        this._dbus('org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, prop]),
            new GLib.VariantType('(v)'),
            reply => callback(reply.recursiveUnpack()[0]));
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

        // Absolute SetPosition avoids drift; relative Seek is the fallback.
        if (this._trackId)
            this._dbus(PLAYER_IFACE, 'SetPosition', new GLib.Variant('(ox)', [this._trackId, target]), null);
        else
            this._dbus(PLAYER_IFACE, 'Seek', new GLib.Variant('(x)', [target - this._lastPosition]), null);

        this._lastPosition = target;
        this._positionLabel.text = formatTime(target);
    }

    destroy() {
        this._stopTimer();
        if (this._seekTimeoutId) {
            GLib.source_remove(this._seekTimeoutId);
            this._seekTimeoutId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._player?.disconnectObject(this);
        this._player = null;
        MediaSeekBar._instances.delete(this);
        if (this._message?._mediaSeekBar === this)
            this._message._mediaSeekBar = null;
        this._message = null;
        super.destroy();
    }
});

export default class MediaSeekbarExtension extends Extension {
    enable() {
        this._injectionManager = new InjectionManager();

        // MediaMessage calls _update() on build and on every player change;
        // ensure the seekbar exists and is synced there.
        this._injectionManager.overrideMethod(
            MessageList.MediaMessage.prototype, '_update',
            originalMethod => function (...args) {
                originalMethod.call(this, ...args);
                MediaSeekBar.ensureOn(this);
            });

        MediaSeekBar.patchExisting();
    }

    disable() {
        this._injectionManager?.clear();
        this._injectionManager = null;
        MediaSeekBar.destroyAll();
    }
}
