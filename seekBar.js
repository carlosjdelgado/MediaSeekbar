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

// m:ss / h:mm:ss vía Date (correcto < 24 h, suficiente para cualquier medio)
const formatTime = microseconds =>
    new Date(Math.max(0, microseconds) / 1000).toISOString().slice(11, 19).replace(/^0(?:0:0?)?/, '');

export class SeekBarManager {
    constructor(messageView) {
        this._messageView = messageView;
        this.bars = {};
        this._syncId = 0;

        this._sync();

        // Players MPRIS que entran/salen: NameOwnerChanged es API estable del bus.
        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            () => this._queueSync());
    }

    // El shell crea/destruye el MediaMessage de forma diferida tras el cambio de
    // nombre, así que se reescanea con un pequeño retardo (y se agrupan ráfagas).
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
            if (!this.bars[busName]) {
                const bar = new SeekBar(busName);
                message.get_child().add_child(bar);
                this.bars[busName] = bar;
            }
        }
        // El shell ya destruyó las barras de players que se fueron (con su
        // message); solo queda soltar la referencia.
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
        for (const bar of Object.values(this.bars))
            bar.destroy();
    }
}

export const SeekBar = GObject.registerClass(
class SeekBar extends St.BoxLayout {
    _init(busName) {
        super._init({style_class: 'seek-bar', x_expand: true});

        this._busName = busName;
        this._length = 0;
        this._trackId = null;
        this._canSeek = false;
        this._dragging = false;
        this._timerId = 0;

        const timeLabel = () => new St.Label({
            style_class: 'seek-timestamp', text: '0:00',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._positionLabel = timeLabel();
        this._slider = new Slider(0);
        this._slider.add_style_class_name('seek-slider');
        this._slider.x_expand = true;
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._slider.connect('drag-begin', () => (this._dragging = true));
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
            this._proxy?.disconnectObject(this);
        });
    }

    _onProxyReady() {
        this._proxy.connectObject('g-properties-changed', () => this._updateInfo(), this);
        this._updateInfo();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._proxy.PlaybackStatus === 'Playing')
                this._refreshPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateInfo() {
        const metadata = this._proxy.Metadata ?? {};
        const rawLength = metadata['mpris:length'];
        this._length = Number(rawLength?.deepUnpack?.() ?? rawLength) || 0;
        this._trackId = metadata['mpris:trackid']?.deepUnpack?.() ?? null;
        this.visible = this._length > 0;
        this._durationLabel.text = formatTime(this._length);
        // CanSeek no siempre está en la caché del proxy (VLC), léelo en vivo.
        this._getProperty('CanSeek', canSeek => {
            this._canSeek = !!canSeek;
            this._slider.reactive = this._canSeek;
        });
        // Refresca la posición también en pausa (al abrir o cambiar de pista).
        this._refreshPosition();
    }

    // SetPosition no está en el XML del shell, así que se llama en crudo.
    _seek(fraction) {
        if (!this._canSeek || !this._trackId || this._length <= 0)
            return;
        const targetMicros = Math.floor(fraction * this._length);
        this._proxy.get_connection().call(
            this._busName, MPRIS_PATH, PLAYER_IFACE, 'SetPosition',
            new GLib.Variant('(ox)', [this._trackId, targetMicros]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    // Position no llega por PropertiesChanged: hay que leerla en vivo.
    _refreshPosition() {
        if (this._dragging || this._length <= 0)
            return;
        this._getProperty('Position', position => {
            this._positionLabel.text = formatTime(position);
            this._slider.value = Math.min(Math.max(position / this._length, 0), 1);
        });
    }

    // Lee una propiedad MPRIS en vivo (la caché del proxy puede estar vacía u obsoleta).
    _getProperty(property, onValue) {
        this._proxy.get_connection().call(
            this._busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, property]),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    onValue(connection.call_finish(result).recursiveUnpack()[0]);
                } catch {}
            });
    }
});
