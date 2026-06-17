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
const formatTime = micros =>
    new Date(Math.max(0, micros) / 1000).toISOString().slice(11, 19).replace(/^0(?:0:0?)?/, '');

export class SeekBarManager {
    constructor(messages) {
        this.bars = {};
        for (const message of messages)
            this._addBar(message);
    }

    _addBar(message) {
        const name = message._player?._busName;
        if (!name || this.bars[name])
            return;

        const bar = new SeekBar(name);
        message.get_child().add_child(bar);
        this.bars[name] = bar;
    }

    destroy() {
        for (const name in this.bars) {
            this.bars[name].destroy();
            delete this.bars[name];
        }
    }
}

export const SeekBar = GObject.registerClass(
class SeekBar extends St.BoxLayout {
    _init(busName) {
        super._init({style_class: 'seek-bar', x_expand: true});

        this._busName = busName;
        this._length = 0;
        this._timerId = 0;

        const label = () => new St.Label({
            style_class: 'seek-timestamp', text: '0:00',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._position = label();
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._duration = label();

        this.add_child(this._position);
        this.add_child(this._slider);
        this.add_child(this._duration);

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
            this._updatePosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateInfo() {
        const length = this._proxy.Metadata?.['mpris:length'];
        this._length = Number(length?.deepUnpack?.() ?? length) || 0;
        this.visible = this._length > 0;
        this._duration.text = formatTime(this._length);
    }

    // Position is omitted from PropertiesChanged, so read it live while playing.
    _updatePosition() {
        if (this._proxy.PlaybackStatus !== 'Playing' || this._length <= 0)
            return;
        this._proxy.get_connection().call(
            this._busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [pos] = conn.call_finish(res).recursiveUnpack();
                    this._position.text = formatTime(pos);
                    this._slider.value = Math.min(Math.max(pos / this._length, 0), 1);
                } catch {}
            });
    }
});
