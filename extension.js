import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SeekBarManager} from './seekBar.js';

export default class MediaSeekbar extends Extension {
    enable() {
        const messageView = Main.panel.statusArea.dateMenu._messageList._messageView;
        this._manager = new SeekBarManager(messageView);
    }

    disable() {
        this._manager?.destroy();
        this._manager = null;
    }
}
