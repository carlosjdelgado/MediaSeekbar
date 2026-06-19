import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML(PLAYER_IFACE));

function formatTime(microseconds) {
    const iso = new Date(Math.max(0, microseconds) / 1000).toISOString();
    return iso.slice(11, 13) === '00' ? iso.slice(14, 19) : iso.slice(11, 19);
}

export class SeekBarManager {
    constructor(messageView) {
        this._messageView = messageView;
        this.bars = {};
        this._syncId = 0;

        this._sync();

        // watch players appear/disappear
        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            () => this._queueSync());

        // a MediaMessage can be destroyed and recreated for the same bus
        // (e.g. YouTube ad break) without NameOwnerChanged firing
        this._childAddedId = this._messageView.connect('child-added',
            () => this._queueSync());
    }

    // debounce; the MediaMessage shows up a bit after NameOwnerChanged
    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const present = new Set();
        for (const message of this._messageView.messages) {
            const busName = message._player?._busName;
            if (!busName)
                continue;
            present.add(busName);
            const existing = this.bars[busName];
            if (!existing || existing.get_parent() !== message.get_child()) {
                const bar = new SeekBar(busName);
                message.get_child().add_child(bar);
                this.bars[busName] = bar;
            }
        }
        // the shell already destroyed the orphan bars; drop refs
        for (const busName in this.bars) {
            if (!present.has(busName))
                delete this.bars[busName];
        }
    }

    destroy() {
        if (this._syncId)
            GLib.source_remove(this._syncId);
        if (this._nameOwnerId)
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
        if (this._childAddedId)
            this._messageView.disconnect(this._childAddedId);
        for (const bar of Object.values(this.bars))
            bar.destroy();
    }
}

export class SeekBar extends St.BoxLayout {
    _init(busName) {
        super._init({style_class: 'seek-bar', x_expand: true});

        this._busName = busName;
        this._length = 0;
        this._trackId = null;
        this._canSeek = false;
        this._dragging = false;
        this._timerId = 0;
        this._basePosition = 0;
        this._baseAt = GLib.get_monotonic_time();

        const timeLabel = () => new St.Label({
            style_class: 'seek-timestamp', text: '0:00',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._positionLabel = timeLabel();
        this._slider = new Slider(0);
        this._slider.add_style_class_name('seek-slider');
        this._slider.x_expand = true;
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            this._seek(this._slider.value);
        });
        this._durationLabel = timeLabel();

        this.add_child(this._positionLabel);
        this.add_child(this._slider);
        this.add_child(this._durationLabel);

        this._proxy = MprisPlayerProxy(Gio.DBus.session, busName, MPRIS_PATH,
            () => this._onProxyReady());
        this.connect('destroy', () => {
            if (this._timerId)
                GLib.source_remove(this._timerId);
            this._proxy.disconnectObject(this);
        });
    }

    _onProxyReady() {
        this._proxy.connectObject('g-properties-changed', () => this._updateInfo(), this);
        this._updateInfo();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._proxy.PlaybackStatus === 'Playing')
                this._renderPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateInfo() {
        const metadata = this._proxy.Metadata ?? {};
        const newLength = Number(metadata['mpris:length']?.deepUnpack?.()) || 0;
        const newTrackId = metadata['mpris:trackid']?.deepUnpack?.() ?? null;
        // Firefox/YouTube emit a transient Metadata without mpris:length on
        // seek; ignore it so we don't blink the bar off and back on
        if (newLength === 0 && newTrackId === this._trackId && this._length > 0)
            return;
        this._length = newLength;
        this._trackId = newTrackId;
        this.visible = this._length > 0;
        this._durationLabel.text = formatTime(this._length);
        // VLC doesn't cache CanSeek
        this._forwardProperty('CanSeek', canSeek => {
            this._canSeek = Boolean(canSeek);
            this._slider.reactive = this._canSeek;
        });
        this._resync();
    }

    // SetPosition isn't in the shell's XML
    _seek(fraction) {
        if (!this._canSeek || !this._trackId || this._length <= 0)
            return;
        const targetMicros = Math.floor(fraction * this._length);
        this._proxy.get_connection().call(
            this._busName, MPRIS_PATH, PLAYER_IFACE, 'SetPosition',
            new GLib.Variant('(ox)', [this._trackId, targetMicros]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
        this._basePosition = targetMicros;
        this._baseAt = GLib.get_monotonic_time();
        this._renderPosition();
    }

    _renderPosition() {
        if (this._dragging || this._length <= 0)
            return;
        const elapsed = this._proxy.PlaybackStatus === 'Playing'
            ? GLib.get_monotonic_time() - this._baseAt
            : 0;
        const position = this._basePosition + elapsed;
        this._positionLabel.text = formatTime(position);
        this._slider.value = Math.min(Math.max(position / this._length, 0), 1);
    }

    // Position isn't in PropertiesChanged: pull it from DBus and snapshot
    _resync() {
        if (this._length <= 0)
            return;
        this._forwardProperty('Position', position => {
            this._basePosition = position;
            this._baseAt = GLib.get_monotonic_time();
            this._renderPosition();
        });
    }

    _forwardProperty(property, onValue) {
        this._proxy.get_connection().call(
            this._busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, property]),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                let value;
                try {
                    value = connection.call_finish(result).recursiveUnpack()[0];
                } catch {
                    return;
                }
                onValue(value);
            });
    }
}

GObject.registerClass(SeekBar);
