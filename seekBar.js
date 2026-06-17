import GObject from 'gi://GObject';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

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

        const bar = new SeekBar();
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
    _init() {
        super._init({style_class: 'seek-bar', x_expand: true});

        this._position = new St.Label({style_class: 'seek-timestamp', text: '0:00'});
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._duration = new St.Label({style_class: 'seek-timestamp', text: '0:00'});

        this.add_child(this._position);
        this.add_child(this._slider);
        this.add_child(this._duration);
    }
});
