// Sketchnote: record the screen while you talk, hold Shift to draw, click to mark.
//
// Alt+Shift+S starts a capture (or finishes the running one). The screen is recorded
// with GNOME Shell's own Screencast service (no portal prompt; only the Shell may call
// it, which is why recording lives here). The microphone and everything after Finish
// live in the Python service (org.sketchnote.Service) on the session bus.
//
// While capturing:  hold Shift + drag  = red stroke (fades on screen, kept in output)
//                   Shift + click      = numbered pin
//                   plain click        = logged as a click event
//                   Ctrl+Z = undo last stroke/pin,  Esc = cancel

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const START_KEY = '<Alt><Shift>s';
const PICKER_MS = 3000;        // mode picker shows this long, then Undo/Cancel/Finish
const FADE_HOLD = 0.5;         // seconds a finished stroke stays fully visible
const FADE_TIME = 1.0;         // ...then fades out over this long
const PIN_MAX_MOVE = 5;        // a Shift-press that moves less than this is a pin
const POLL_MS = 10;
const GLOW_WIDTH = 28;         // px of red fade along each screen edge

const now = () => GLib.get_monotonic_time();   // µs, same clock as Python's time.monotonic

async function call(dest, path, iface, method, params = null, replyType = null) {
    const reply = await Gio.DBus.session.call(dest, path, iface, method, params,
        replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NONE, -1, null);
    return reply?.deepUnpack();
}

const service = (method, params, replyType) => call('org.sketchnote.Service',
    '/org/sketchnote/Service', 'org.sketchnote.Service', method, params, replyType);
const screencast = (method, params, replyType) => call('org.gnome.Shell.Screencast',
    '/org/gnome/Shell/Screencast', 'org.gnome.Shell.Screencast', method, params, replyType);

// App name, title and frame rect of the topmost ordinary window under (x, y).
function windowAt(x, y) {
    for (const actor of global.get_window_actors().slice().reverse()) {
        const w = actor.meta_window;
        if (!w || w.minimized || w.skip_taskbar || !w.showing_on_its_workspace())
            continue;
        const r = w.get_frame_rect();
        if (x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height)
            return windowInfo(w);
    }
    return null;
}

function inside(actor, x, y) {
    const [ax, ay] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return x >= ax && y >= ay && x < ax + w && y < ay + h;
}

function windowInfo(w) {
    if (!w)
        return null;
    const r = w.get_frame_rect();
    const app = Shell.WindowTracker.get_default().get_window_app(w);
    return {
        app: app?.get_name() ?? w.get_wm_class() ?? '',
        title: w.get_title() ?? '',
        rect: [r.x, r.y, r.width, r.height],
    };
}

// Panel icon: brush always, plus a stop square while capturing. Click toggles.
const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(onClick) {
        super._init(0.0, 'Sketchnote', true);
        this._onClick = onClick;
        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        this._stop = new St.Icon({icon_name: 'media-playback-stop-symbolic',
            style_class: 'system-status-icon', visible: false});
        box.add_child(this._stop);
        box.add_child(new St.Icon({icon_name: 'document-edit-symbolic',
            style_class: 'system-status-icon'}));
        this.add_child(box);
    }

    setRecording(on) {
        this._stop.visible = on;
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_RELEASE ||
            event.type() === Clutter.EventType.TOUCH_END) {
            this._onClick();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});

// Live strokes and pins, drawn above all windows. Finished items fade out.
class Ink {
    constructor() {
        this.items = [];
        this.actor = new St.DrawingArea({reactive: false, x: 0, y: 0,
            width: global.stage.width, height: global.stage.height});
        this.actor.connect('repaint', area => this._paint(area));
        this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            const t = now() / 1e6;
            this.items = this.items.filter(it => it.doneAt === null ||
                t - it.doneAt < FADE_HOLD + FADE_TIME);
            this.actor.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    remove(item) {
        this.items = this.items.filter(it => it !== item);
    }

    _paint(area) {
        const cr = area.get_context();
        const t = now() / 1e6;
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineWidth(3);
        for (const it of this.items) {
            const fade = it.doneAt === null ? 0 : (t - it.doneAt - FADE_HOLD) / FADE_TIME;
            const alpha = 1 - Math.min(1, Math.max(0, fade));
            cr.setSourceRGBA(1, 0.19, 0.19, alpha);
            if (it.points) {
                const [[x0, y0], ...rest] = it.points;
                cr.moveTo(x0, y0);
                for (const [x, y] of rest)
                    cr.lineTo(x, y);
                cr.stroke();
            } else {
                cr.arc(it.x, it.y, 13, 0, 2 * Math.PI);
                cr.fill();
                cr.setSourceRGBA(1, 1, 1, alpha);
                cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
                cr.setFontSize(14);
                const label = String(it.n);
                const ext = cr.textExtents(label);
                cr.moveTo(it.x - ext.width / 2 - ext.xBearing, it.y - ext.height / 2 - ext.yBearing);
                cr.showText(label);
            }
        }
        cr.$dispose();
    }

    destroy() {
        GLib.source_remove(this._tick);
        this.actor.destroy();
    }
}

// The top-centre pill: picker phase (Area / Window / Screen), then Undo / Cancel / Finish.
class Pill {
    constructor({onMode, onUndo, onCancel, onFinish}) {
        this.actor = new St.BoxLayout({style_class: 'sketchnote-pill', reactive: true});
        this.actor.add_child(new St.Widget({style_class: 'sketchnote-dot',
            y_align: Clutter.ActorAlign.CENTER}));
        this._timer = new St.Label({style_class: 'sketchnote-timer', text: '0:00',
            y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._timer);
        this.actor.add_child(new St.Widget({style_class: 'sketchnote-sep'}));

        this._modes = {};
        for (const [mode, label] of [['area', 'Area'], ['window', 'Window'], ['screen', 'Screen']]) {
            const b = this._button(label, () => onMode(mode));
            this._modes[mode] = b;
        }
        this.undo = this._button('Undo', onUndo);
        this._cancel = this._button('Cancel', onCancel);
        this._finish = this._button('Finish', onFinish, 'sketchnote-finish');

        this.actor.connect('notify::width', () => this._place());
        Main.layoutManager.addTopChrome(this.actor);
    }

    _button(label, onClick, extraClass = '') {
        const b = new St.Button({label, style_class: `sketchnote-btn ${extraClass}`,
            y_align: Clutter.ActorAlign.CENTER});
        b.connect('clicked', onClick);
        this.actor.add_child(b);
        return b;
    }

    _place() {
        if (!this.actor.get_stage())
            return;
        const m = Main.layoutManager.primaryMonitor;
        this.actor.set_position(m.x + Math.floor((m.width - this.actor.width) / 2),
            m.y + Main.panel.height + 8);
    }

    showPicker(selected) {
        for (const [mode, b] of Object.entries(this._modes)) {
            b.visible = true;
            if (mode === selected)
                b.add_style_class_name('selected');
            else
                b.remove_style_class_name('selected');
        }
        for (const b of [this.undo, this._cancel, this._finish])
            b.visible = false;
    }

    showActions() {
        for (const b of Object.values(this._modes))
            b.visible = false;
        for (const b of [this.undo, this._cancel, this._finish])
            b.visible = true;
    }

    setTime(seconds) {
        const s = Math.floor(seconds);
        this._timer.text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    destroy() {
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }
}

export default class Sketchnote extends Extension {
    enable() {
        this._session = null;
        this._stopping = Promise.resolve();     // the previous session's teardown
        this._ui = null;
        this._stroke = null;
        this._keys = new Map();     // action id -> handler
        this._indicator = new Indicator(() => this._toggle());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._accelId = global.display.connect('accelerator-activated', (_d, action) => {
            this._keys.get(action)?.();
        });
        this._startKey = this._grabKey(START_KEY, () => this._toggle());
    }

    disable() {
        if (this._session)
            this._cancel();
        this._ungrabKey(this._startKey);
        global.display.disconnect(this._accelId);
        this._indicator.destroy();
        this._indicator = null;
    }

    _grabKey(accel, handler) {
        const action = global.display.grab_accelerator(accel, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
        if (action === Meta.KeyBindingAction.NONE) {
            console.warn(`sketchnote: could not grab ${accel}`);
            return null;
        }
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.ALL);
        this._keys.set(action, handler);
        return action;
    }

    _ungrabKey(action) {
        if (action === null || action === undefined)
            return;
        global.display.ungrab_accelerator(action);
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NONE);
        this._keys.delete(action);
    }

    _toggle() {
        if (this._selecting)
            this._cancel();
        else if (this._session)
            this._finish();
        else
            this._start('screen', null, true);
    }

    // --- capture lifecycle --------------------------------------------------

    _start(mode, rect, withPicker) {
        const focus = windowInfo(global.display.focus_window);
        this._showUi(withPicker ? mode : null);
        const s = {t0: now(), mode, focus, events: [], video: null, videoT0: 0};
        s.area = rect ?? [0, 0, global.stage.width, global.stage.height];
        this._session = s;
        this._lastInk = [];
        s.ready = this._record(s);
    }

    // The service and GNOME's screencast each handle one recording at a time, so a new
    // session waits until the previous one (possibly still starting up) has fully stopped.
    async _record(s) {
        try {
            await this._stopping;
            const [dir] = await service('Start', null, '(s)');
            const [ok, used] = await this._screencast(s, GLib.build_filenamev([dir, 'screencast']));
            if (!ok)
                throw new Error('GNOME Shell refused to start the screencast');
            s.video = used;
            s.videoT0 = now();
        } catch (e) {
            console.error(`sketchnote: start failed: ${e.message}`);
            Main.notify('Sketchnote', `Could not start recording: ${e.message}`);
            if (s === this._session)
                this._cancel();
        }
    }

    // GNOME's recorder service can crash while setting up a pipeline; it then blocklists
    // that pipeline, so (like GNOME's own screenshot UI) retry a couple of times.
    async _screencast(s, template) {
        const opts = {'draw-cursor': GLib.Variant.new_boolean(true)};
        for (let attempt = 0; ; attempt++) {
            try {
                return s.mode === 'screen'
                    ? await screencast('Screencast',
                        new GLib.Variant('(sa{sv})', [template, opts]), '(bs)')
                    : await screencast('ScreencastArea',
                        new GLib.Variant('(iiiisa{sv})', [...s.area, template, opts]), '(bs)');
            } catch (e) {
                if (attempt >= 2 || !e.matches?.(Gio.DBusError, Gio.DBusError.NO_REPLY))
                    throw e;
                console.log('sketchnote: screencast service crashed during startup, retrying');
            }
        }
    }

    async _stopRecording(s) {
        await s.ready;
        if (s.video)
            await screencast('StopScreencast', null, '(b)').catch(logError);
    }

    _finish() {
        const s = this._session;
        const end = now();
        this._session = null;
        this._hideUi();
        this._stopping = this._save(s, end).catch(logError);
        return this._stopping;
    }

    async _save(s, end) {
        await this._stopRecording(s);
        if (!s.video) {
            await service('Cancel').catch(logError);
            return;
        }
        const capture = {
            t0: s.t0, end, video_t0: s.videoT0, video: s.video,
            mode: s.mode, area: s.area, window: s.focus, events: s.events,
        };
        await service('Finish', new GLib.Variant('(s)', [JSON.stringify(capture)]), '(s)')
            .catch(e => Main.notify('Sketchnote', `Could not save capture: ${e.message}`));
    }

    _cancel() {
        this._endSelection();
        const s = this._session;
        this._session = null;
        this._hideUi();
        if (!s)
            return this._stopping;
        this._stopping = this._stopRecording(s)
            .then(() => service('Cancel')).catch(logError);
        return this._stopping;
    }

    // Picker click: restart the capture in the chosen mode (the timer starts over).
    async _pickMode(mode) {
        const s = this._session;
        if (mode === s.mode) {
            this._ui.pill.showActions();
            return;
        }
        if (mode === 'window') {
            const w = s.focus;
            await this._cancel();
            this._start(w ? 'window' : 'screen', w?.rect ?? null, false);
        } else {
            await this._cancel();
            this._selectArea(rect => this._start('area', rect, false));
        }
    }

    // --- UI -------------------------------------------------------------------

    _showUi(pickerMode) {
        const ui = {};
        ui.glows = Main.layoutManager.monitors.map(m => {
            const g = new St.Widget({style_class: 'sketchnote-glow', reactive: false,
                x: m.x, y: m.y, width: m.width, height: m.height});
            const e = GLOW_WIDTH;
            for (const [side, x, y, w, h] of [['top', 0, 0, m.width, e],
                ['bottom', 0, m.height - e, m.width, e], ['left', 0, 0, e, m.height],
                ['right', m.width - e, 0, e, m.height]]) {
                g.add_child(new St.Widget({style_class: `sketchnote-glow-${side}`,
                    x, y, width: w, height: h}));
            }
            Main.uiGroup.add_child(g);
            return g;
        });
        ui.ink = new Ink();
        Main.uiGroup.add_child(ui.ink.actor);
        // Takes pointer input only while Shift is held, so normal clicks reach apps.
        ui.catcher = new St.Widget({reactive: false, x: 0, y: 0,
            width: global.stage.width, height: global.stage.height});
        ui.catcher.connect('event', (_a, event) => this._onDrawEvent(event));
        Main.uiGroup.add_child(ui.catcher);

        ui.pill = new Pill({
            onMode: mode => this._pickMode(mode),
            onUndo: () => this._undo(),
            onCancel: () => this._cancel(),
            onFinish: () => this._finish(),
        });
        if (pickerMode) {
            ui.pill.showPicker(pickerMode);
            ui.pickerTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PICKER_MS, () => {
                ui.pickerTimeout = 0;
                ui.pill.showActions();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            ui.pill.showActions();
        }
        ui.pill.undo.reactive = false;
        ui.clock = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (this._session)
                ui.pill.setTime((now() - this._session.t0) / 1e6);
            return GLib.SOURCE_CONTINUE;
        });
        ui.poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
        ui.keys = [this._grabKey('Escape', () => this._cancel()),
            this._grabKey('<Control>z', () => this._undo())];
        this._indicator.setRecording(true);
        this._ui = ui;
    }

    _hideUi() {
        const ui = this._ui;
        if (!ui)
            return;
        this._ui = null;
        this._stroke = null;
        this._releaseGrab();
        for (const id of [ui.clock, ui.poll, ui.pickerTimeout])
            if (id)
                GLib.source_remove(id);
        ui.keys.forEach(k => this._ungrabKey(k));
        ui.glows.forEach(g => g.destroy());
        ui.ink.destroy();
        ui.catcher.destroy();
        ui.pill.destroy();
        this._indicator.setRecording(false);
    }

    // --- input ---------------------------------------------------------------

    // Watches Shift (to switch the catcher on/off) and logs plain clicks anywhere.
    _poll() {
        const [x, y, mods] = global.get_pointer();
        const shift = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const down = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
        // A stage grab routes the pointer to the catcher immediately; just flipping
        // `reactive` would only take effect after the next repaint.
        const draw = shift || this._stroke !== null;
        if (draw && !this._grab) {
            this._ui.catcher.reactive = true;
            this._grab = global.stage.grab(this._ui.catcher);
        } else if (!draw && this._grab) {
            this._releaseGrab();
        }
        if (down && !this._wasDown && !shift && !this._stroke &&
            !inside(this._ui.pill.actor, x, y) && !inside(Main.panel, x, y))
            this._addEvent({type: 'click', x, y});
        this._wasDown = down;
    }

    _onDrawEvent(event) {
        const type = event.type();
        const [x, y] = event.get_coords();
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1) {
            this._stroke = {points: [[x, y]], doneAt: null, t: this._elapsed()};
            this._ui.ink.items.push(this._stroke);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.MOTION && this._stroke) {
            const [lx, ly] = this._stroke.points.at(-1);
            if (Math.hypot(x - lx, y - ly) >= 1)
                this._stroke.points.push([x, y]);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE && this._stroke) {
            this._endStroke();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _endStroke() {
        const item = this._stroke;
        this._stroke = null;
        const [x0, y0] = item.points[0];
        const moved = Math.max(...item.points.map(([x, y]) => Math.hypot(x - x0, y - y0)));
        item.doneAt = now() / 1e6;
        if (moved < PIN_MAX_MOVE) {
            // Shift+click: turn it into a numbered pin (its number is its mark number).
            item.points = null;
            Object.assign(item, {x: x0, y: y0, n: this._session.events.length + 1});
            item.event = this._addEvent({type: 'pin', x: x0, y: y0, t: item.t});
        } else {
            item.event = this._addEvent({type: 'stroke', t: item.t, t_end: this._elapsed(),
                points: item.points.map(([x, y]) => [Math.round(x), Math.round(y)])}, x0, y0);
        }
        this._lastInk.push(item);
        this._ui.pill.undo.reactive = true;
    }

    _releaseGrab() {
        this._grab?.dismiss();
        this._grab = null;
        if (this._ui)
            this._ui.catcher.reactive = false;
    }

    _addEvent(event, wx = event.x, wy = event.y) {
        const e = {t: this._elapsed(), ...event, window: windowAt(wx, wy)};
        this._session.events.push(e);
        return e;
    }

    // Undo removes the most recent stroke or pin (clicks are not undoable).
    _undo() {
        const item = this._lastInk.pop();
        if (!item || !this._session)
            return;
        this._session.events = this._session.events.filter(e => e !== item.event);
        this._ui.ink.remove(item);
        this._ui.pill.undo.reactive = this._lastInk.length > 0;
    }

    _elapsed() {
        return Math.round((now() - this._session.t0) / 1000) / 1000;
    }

    // --- area selection --------------------------------------------------------

    _selectArea(done) {
        const overlay = new St.Widget({style_class: 'sketchnote-select', reactive: true,
            x: 0, y: 0, width: global.stage.width, height: global.stage.height});
        const box = new St.Widget({style_class: 'sketchnote-select-rect', visible: false});
        overlay.add_child(box);
        Main.layoutManager.addTopChrome(overlay);
        const esc = this._grabKey('Escape', () => this._endSelection());
        let start = null;
        let grab = null;
        const rect = (x, y) => [Math.min(x, start[0]), Math.min(y, start[1]),
            Math.abs(x - start[0]), Math.abs(y - start[1])];
        overlay.connect('event', (_a, event) => {
            const [x, y] = event.get_coords();
            switch (event.type()) {
            case Clutter.EventType.BUTTON_PRESS:
                start = [x, y];
                grab = global.stage.grab(overlay);
                return Clutter.EVENT_STOP;
            case Clutter.EventType.MOTION:
                if (start) {
                    const [rx, ry, rw, rh] = rect(x, y);
                    box.set_position(rx, ry);
                    box.set_size(rw, rh);
                    box.visible = true;
                }
                return Clutter.EVENT_STOP;
            case Clutter.EventType.BUTTON_RELEASE: {
                if (!start)
                    return Clutter.EVENT_STOP;
                const r = rect(x, y).map(Math.round);
                grab?.dismiss();
                this._endSelection();
                // Screencasts need even sizes; ignore accidental tiny drags.
                if (r[2] >= 16 && r[3] >= 16)
                    done([r[0], r[1], r[2] & ~1, r[3] & ~1]);
                return Clutter.EVENT_STOP;
            }
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._selecting = {overlay, esc};
    }

    _endSelection() {
        const sel = this._selecting;
        if (!sel)
            return;
        this._selecting = null;
        this._ungrabKey(sel.esc);
        Main.layoutManager.removeChrome(sel.overlay);
        sel.overlay.destroy();
    }
}
