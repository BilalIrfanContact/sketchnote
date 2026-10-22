// Sketchnote: record the screen while you talk, hold Shift to draw, click to mark.
//
// Alt+Shift+S starts a capture (or finishes the running one). The screen is recorded
// with GNOME Shell's own Screencast service (no portal prompt; only the Shell may call
// it, which is why recording lives here). The microphone and everything after Finish
// live in the Rust service (org.sketchnote.Service) on the session bus.
//
// While capturing:  hold Shift + drag  = red stroke (fades on screen, kept in output)
//                   Shift + click      = pin (numbered in the notes)
//                   plain click        = logged as a click event
//                   Ctrl+Z = undo last stroke/pin,  Esc = cancel
//
// When a capture is ready its notes go on the clipboard, and the next Ctrl+V pastes the
// notes and then the contact sheet (two ordinary pastes, so any app accepts them).
// Alt+Shift+V does the same for the latest capture at any time.

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
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const START_KEY = '<Alt><Shift>s';
const PASTE_KEY = '<Control>v';
const PASTE_LATEST_KEY = '<Alt><Shift>v';
const PASTE_SETTLE_MS = 400;   // time an app gets to read the clipboard before it changes
const TEXT_MIME = 'text/plain;charset=utf-8';
const CAPTURES = GLib.build_filenamev([GLib.get_user_data_dir(), 'sketchnote', 'captures']);
const FADE_HOLD = 0.5;         // seconds a finished stroke stays fully visible
const FADE_TIME = 1.0;         // ...then fades out over this long
const PIN_MAX_MOVE = 5;        // a Shift+press that moves less than this is a pin
const POLL_MS = 10;
const GLOW_WIDTH = 28;         // px of red fade along each screen edge
const STATUS_MS = 6000;        // a "Ready" or "Failed" status hides itself after this
const DOT_STATES = ['starting', 'recording', 'busy', 'ready', 'failed'];
const METER_MS = 100;

const now = () => GLib.get_monotonic_time();   // µs, same clock as Python's time.monotonic
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function call(dest, path, iface, method, params = null, replyType = null) {
    const reply = await Gio.DBus.session.call(dest, path, iface, method, params,
        replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NONE, -1, null);
    return reply?.deepUnpack();
}

const service = (method, params, replyType) => call('org.sketchnote.Service',
    '/org/sketchnote/Service', 'org.sketchnote.Service', method, params, replyType);
const screencast = (method, params, replyType) => call('org.gnome.Shell.Screencast',
    '/org/gnome/Shell/Screencast', 'org.gnome.Shell.Screencast', method, params, replyType);

// A notification that stays in the message tray until dismissed. `actions` are
// [label, callback] pairs, shown as buttons.
function notifyProblem(title, body, actions = []) {
    const source = MessageTray.getSystemSource();
    const notification = new MessageTray.Notification({source, title, body});
    for (const [label, callback] of actions)
        notification.addAction(label, callback);
    source.addNotification(notification);
}

// What to tell the user about a failed call: the service's own sentence, or what to do
// when D-Bus can't start the service at all.
function describe(e) {
    const name = e instanceof GLib.Error ? Gio.DBusError.get_remote_error(e) : null;
    if (name === 'org.freedesktop.DBus.Error.ServiceUnknown' ||
        name?.startsWith('org.freedesktop.DBus.Error.Spawn'))
        return "Sketchnote's background service isn't installed or won't start. Run install.sh, then try again.";
    if (name)
        Gio.DBusError.strip_remote_error(e);
    return e.message;
}

// Newest bundle that has finished building (it has a summary.md), or null.
function latestBundle() {
    const names = [];
    try {
        const files = Gio.File.new_for_path(CAPTURES).enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = files.next_file(null));)
            names.push(info.get_name());
    } catch {
        return null;
    }
    return names.sort().reverse().map(n => GLib.build_filenamev([CAPTURES, n]))
        .find(dir => GLib.file_test(`${dir}/summary.md`, GLib.FileTest.EXISTS)) ?? null;
}

function readFile(path) {
    try {
        return GLib.file_get_contents(path)[1];
    } catch {
        return null;
    }
}

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
                // No number yet: it's only final once the notes are built (a click
                // nobody spoke about loses its number). Keyframes get the real one.
                cr.arc(it.x, it.y, 13, 0, 2 * Math.PI);
                cr.fill();
            }
        }
        cr.$dispose();
    }

    destroy() {
        GLib.source_remove(this._tick);
        this.actor.destroy();
    }
}

// The top-centre pill. During a capture: a state dot, "Starting…" or the timer, then
// Undo / Cancel / Finish. After one: a status line (Saving… / Transcribing… / Ready)
// with no buttons.
class Pill {
    constructor({onUndo, onCancel, onFinish} = {}) {
        this.actor = new St.BoxLayout({style_class: 'sketchnote-pill', reactive: true});
        this._dot = new St.Widget({style_class: 'sketchnote-dot', y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._dot);
        this._timer = new St.Label({style_class: 'sketchnote-timer', text: '',
            y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._timer);
        // Mic level: a bar that follows your voice while recording.
        this._meter = new St.Widget({style_class: 'sketchnote-meter', y_align: Clutter.ActorAlign.CENTER,
            visible: false});
        // Full track width, scaled down to the level (so HiDPI scaling just works).
        this._meterFill = new St.Widget({style_class: 'sketchnote-meter-fill', scale_x: 0});
        this._level = 0;
        this._meter.add_child(this._meterFill);
        this.actor.add_child(this._meter);
        this._micWarning = new St.Label({style_class: 'sketchnote-mic-warning', text: 'Mic is silent',
            y_align: Clutter.ActorAlign.CENTER, visible: false});
        this.actor.add_child(this._micWarning);
        this._sep = new St.Widget({style_class: 'sketchnote-sep'});
        this.actor.add_child(this._sep);

        this.undo = this._button('Undo', onUndo);
        this._cancel = this._button('Cancel', onCancel);
        this._finish = this._button('Finish', onFinish, 'sketchnote-finish');

        this.actor.connect('notify::width', () => this._place());
        Main.layoutManager.addTopChrome(this.actor);
    }

    _button(label, onClick, extraClass = '') {
        const b = new St.Button({label, style_class: `sketchnote-btn ${extraClass}`,
            y_align: Clutter.ActorAlign.CENTER});
        if (onClick)
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

    // One of DOT_STATES colours the dot; `text` replaces the timer (null keeps it).
    setState(state, text = null) {
        DOT_STATES.forEach(st => this._dot.remove_style_class_name(st));
        this._dot.add_style_class_name(state);
        if (text !== null)
            this._timer.text = text;
    }

    // Status-only pill: no separator, no buttons.
    showStatus(state, text) {
        this._sep.visible = false;
        for (const b of [this.undo, this._cancel, this._finish])
            b.visible = false;
        this.setState(state, text);
    }

    // `level` 0..1; jumps up at once, falls back smoothly so speech doesn't flicker.
    setMicLevel(level) {
        this._meter.visible = true;
        this._level = Math.max(level, this._level * 0.75);
        this._meterFill.scale_x = this._level;
    }

    setMicSilent(silent) {
        this._micWarning.visible = silent;
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

        this._armed = null;         // the capture on the clipboard, while Ctrl+V is ours
        this._keyboard = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (_s, type, source) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD && source !== this._armed?.source)
                this._disarm();     // something else was copied: Ctrl+V is normal again
        });
        this._readyId = Gio.DBus.session.signal_subscribe(null, 'org.sketchnote.Service',
            'BundleReady', '/org/sketchnote/Service', null, Gio.DBusSignalFlags.NONE,
            (_c, _sender, _path, _iface, _signal, params) => this._onBundleReady(...params.deepUnpack()));
        this._failedId = Gio.DBus.session.signal_subscribe(null, 'org.sketchnote.Service',
            'BundleFailed', '/org/sketchnote/Service', null, Gio.DBusSignalFlags.NONE,
            (_c, _sender, _path, _iface, _signal, params) => this._onBundleFailed(...params.deepUnpack()));
        // If the service dies mid-build (say, whisper crashes), no signal ever comes.
        this._serviceWatch = Gio.bus_watch_name(Gio.BusType.SESSION, 'org.sketchnote.Service',
            Gio.BusNameWatcherFlags.NONE, null, () => this._onServiceGone());
        this._status = null;        // the after-capture status pill
        this._owner = null;         // the finished capture the status pill is about
        this._pasteLatestKey = this._grabKey(PASTE_LATEST_KEY, () => this._pasteLatest());
    }

    disable() {
        if (this._session)
            this._cancel();
        this._disarm();
        this._owner = null;         // in-flight saves must not bring the pill back
        this._hideStatus();
        Gio.DBus.session.signal_unsubscribe(this._readyId);
        Gio.DBus.session.signal_unsubscribe(this._failedId);
        Gio.bus_unwatch_name(this._serviceWatch);
        this._selection.disconnect(this._ownerId);
        this._selection = null;
        this._keyboard = null;
        this._ungrabKey(this._pasteLatestKey);
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
        if (this._session)
            this._finish();
        else
            this._start();
    }

    // --- after Finish: Saving… -> Transcribing… -> Ready / Failed ----------------

    // Shows the status pill, unless a new capture's pill is up. `ms` > 0 hides it after.
    _showStatus(state, text, ms = 0) {
        if (this._session)
            return;
        if (!this._status)
            this._status = {pill: new Pill(), timeout: 0};
        const st = this._status;
        st.pill.showStatus(state, text);
        if (st.timeout)
            GLib.source_remove(st.timeout);
        st.timeout = ms ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            st.timeout = 0;
            this._hideStatus();
            return GLib.SOURCE_REMOVE;
        }) : 0;
    }

    _hideStatus() {
        const st = this._status;
        if (!st)
            return;
        this._status = null;
        if (st.timeout)
            GLib.source_remove(st.timeout);
        st.pill.destroy();
    }

    // Status updates only apply to the latest finished capture, so an older capture
    // finishing late can't overwrite a newer one's status.
    _ownStatus(s, state, text, ms = 0) {
        if (this._owner !== s)
            return;
        if (ms)
            this._owner = null;     // terminal: nothing else may change it
        this._showStatus(state, text, ms);
    }

    // `warning` is the service's sentence if the notes were made another way than set
    // up (the local model stood in for a failed API); Retry tries the usual way again.
    _onBundleReady(dir, warning = '') {
        this._arm(dir);
        const s = this._owner;
        if (s?.dir === dir) {
            this._ownStatus(s, 'ready', warning ? 'Ready (local model) · Ctrl+V to paste'
                : 'Ready · Ctrl+V to paste', STATUS_MS);
        }
        if (warning)
            notifyProblem('Transcribed with the local model', warning, [['Retry', () => this._retry(dir)]]);
    }

    // `reason` is the service's sentence for the user; the recordings are kept, so the
    // notification offers to build them again.
    _onBundleFailed(dir, reason = 'Something unexpected went wrong.') {
        const s = this._owner;
        if (s?.dir === dir)
            this._ownStatus(s, 'failed', "Couldn't build the notes", STATUS_MS);
        notifyProblem("Couldn't build the notes", reason, [['Retry', () => this._retry(dir)]]);
    }

    _onServiceGone() {
        const s = this._owner;
        if (s?.building) {
            this._onBundleFailed(s.dir,
                "Sketchnote's background service stopped while building the notes. Retry to build them again.");
        }
    }

    // Builds a failed capture again; the pill follows it as it did after Finish.
    async _retry(dir) {
        const s = {dir, building: false};
        this._owner = s;
        this._showStatus('busy', 'Retrying…');
        try {
            await service('Retry', new GLib.Variant('(s)', [dir]));
            s.building = true;
        } catch (e) {
            notifyProblem("Couldn't retry", describe(e), [['Retry', () => this._retry(dir)]]);
            this._ownStatus(s, 'failed', "Couldn't retry", STATUS_MS);
        }
    }

    // --- clipboard: one Ctrl+V pastes the notes and the contact sheet ---------

    _arm(dir) {
        this._disarm();
        const text = readFile(`${dir}/summary.md`);
        if (!text)
            return;
        this._armed = {text, image: readFile(`${dir}/contact-sheet.png`), source: null};
        this._setClipboard(TEXT_MIME, text);
        this._armed.key = this._grabKey(PASTE_KEY, () => this._pasteAll());
    }

    _disarm() {
        if (this._armed)
            this._ungrabKey(this._armed.key);
        this._armed = null;
    }

    _setClipboard(mime, bytes) {
        this._armed.source = Meta.SelectionSourceMemory.new(mime, new GLib.Bytes(bytes));
        this._selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, this._armed.source);
    }

    // Types Ctrl+V for the app twice: once with the notes on the clipboard, once with
    // the contact sheet. Then the notes go back, ready for another Ctrl+V.
    async _pasteAll() {
        const a = this._armed;
        if (!a?.key)
            return;                 // a paste is already running
        this._ungrabKey(a.key);     // so the Ctrl+V typed below reaches the app
        a.key = null;
        this._hideStatus();
        await this._waitForKeysUp();
        if (this._armed === a)
            await this._typeCtrlV();
        if (a.image && this._armed === a) {
            this._setClipboard('image/png', a.image);
            await this._typeCtrlV();
        }
        if (this._armed === a) {
            this._setClipboard(TEXT_MIME, a.text);
            a.key = this._grabKey(PASTE_KEY, () => this._pasteAll());
        }
    }

    _pasteLatest() {
        const dir = latestBundle();
        if (dir) {
            this._arm(dir);
            this._pasteAll();
        } else {
            Main.notify('Sketchnote', 'No finished capture yet');
        }
    }

    // The hotkey that triggered a paste is still down. Mutter drops a V press from our
    // virtual keyboard while the real V is held, and the app must not see Alt or Shift,
    // so wait for V to come up (a short stage grab catches its release) and for Alt/Shift.
    async _waitForKeysUp() {
        const catcher = new Clutter.Actor({reactive: true});
        Main.uiGroup.add_child(catcher);
        const grab = global.stage.grab(catcher);
        await new Promise(resolve => {
            catcher.connect('event', (_a, event) => {
                if (event.type() === Clutter.EventType.KEY_RELEASE &&
                    [Clutter.KEY_v, Clutter.KEY_V].includes(event.get_key_symbol()))
                    resolve();
                return Clutter.EVENT_STOP;
            });
            sleep(1000).then(resolve);      // V was already up before the grab
        });
        grab.dismiss();
        catcher.destroy();
        const held = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.MOD1_MASK;
        for (let ms = 0; ms < 3000 && (global.get_pointer()[2] & held); ms += 10)
            await sleep(10);
    }

    async _typeCtrlV() {
        const {PRESSED, RELEASED} = Clutter.KeyState;
        for (const [key, state] of [[Clutter.KEY_Control_L, PRESSED], [Clutter.KEY_v, PRESSED],
            [Clutter.KEY_v, RELEASED], [Clutter.KEY_Control_L, RELEASED]])
            this._keyboard.notify_keyval(now(), key, state);
        await sleep(PASTE_SETTLE_MS);
    }

    // --- capture lifecycle --------------------------------------------------

    // Always records the whole screen (every monitor); the contact sheet crops to the marks.
    _start() {
        const focus = windowInfo(global.display.focus_window);
        this._hideStatus();
        this._showUi();
        const s = {t0: now(), focus, events: [], video: null, videoT0: 0};
        s.area = [0, 0, global.stage.width, global.stage.height];
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
            s.dir = dir;
            const [ok, used] = await this._screencast(GLib.build_filenamev([dir, 'screencast']));
            if (!ok)
                throw new Error("GNOME wouldn't start the screen recording. Try again; if it keeps failing, log out and back in.");
            s.video = used;
            s.videoT0 = now();
            if (s === this._session)
                this._showRecording();
        } catch (e) {
            console.error(`sketchnote: start failed: ${e.message}`);
            notifyProblem("Couldn't start recording", describe(e));
            if (s === this._session)
                this._cancel();
        }
    }

    // GNOME's recorder service can crash while setting up a pipeline; it then blocklists
    // that pipeline, so (like GNOME's own screenshot UI) retry a couple of times.
    async _screencast(template) {
        const opts = {'draw-cursor': GLib.Variant.new_boolean(true)};
        for (let attempt = 0; ; attempt++) {
            try {
                return await screencast('Screencast',
                    new GLib.Variant('(sa{sv})', [template, opts]), '(bs)');
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
        // Where the pill sat, so the service can crop it out of keyframes.
        const p = this._ui?.pill.actor;
        s.pill = p ? [p.x, p.y, p.width, p.height] : null;
        this._session = null;
        this._hideUi();
        this._owner = s;
        this._showStatus('busy', 'Saving…');
        this._stopping = this._save(s, end).catch(logError);
        return this._stopping;
    }

    async _save(s, end) {
        await this._stopRecording(s);
        if (!s.video) {     // recording never started (already reported)
            if (this._owner === s) {
                this._owner = null;
                this._hideStatus();
            }
            await service('Cancel').catch(logError);
            return;
        }
        const capture = {
            t0: s.t0, end, video_t0: s.videoT0, video: s.video,
            area: s.area, pill: s.pill, window: s.focus, events: s.events,
        };
        try {
            await service('Finish', new GLib.Variant('(s)', [JSON.stringify(capture)]), '(s)');
            s.building = true;
            this._ownStatus(s, 'busy', 'Transcribing…');    // no-op if it's already Ready
        } catch (e) {
            notifyProblem("Couldn't save the capture", describe(e));
            this._ownStatus(s, 'failed', "Couldn't save the capture", STATUS_MS);
        }
    }

    _cancel() {
        const s = this._session;
        this._session = null;
        this._hideUi();
        if (!s)
            return this._stopping;
        this._stopping = this._stopRecording(s)
            .then(() => service('Cancel')).catch(logError);
        return this._stopping;
    }

    // --- UI -------------------------------------------------------------------

    _showUi() {
        const ui = {glows: []};
        ui.ink = new Ink();
        Main.uiGroup.add_child(ui.ink.actor);
        // Takes input only while Shift is held, so normal clicks reach apps.
        ui.catcher = new St.Widget({reactive: false, x: 0, y: 0,
            width: global.stage.width, height: global.stage.height});
        ui.catcher.connect('event', (_a, event) => this._onDrawEvent(event));
        Main.uiGroup.add_child(ui.catcher);

        ui.pill = new Pill({
            onUndo: () => this._undo(),
            onCancel: () => this._cancel(),
            onFinish: () => this._finish(),
        });
        ui.pill.undo.reactive = false;
        ui.pill.setState('starting', 'Starting…');
        ui.clock = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (this._session?.video)
                ui.pill.setTime((now() - this._session.t0) / 1e6);
            return GLib.SOURCE_CONTINUE;
        });
        ui.poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
        // Shortcuts only match their exact modifiers, so the Shift variants cover Esc and
        // Ctrl+Z pressed while Shift is still held after drawing.
        ui.keys = [this._grabKey('Escape', () => this._cancel()),
            this._grabKey('<Shift>Escape', () => this._cancel()),
            this._grabKey('<Control>z', () => this._undo()),
            this._grabKey('<Control><Shift>z', () => this._undo())];
        this._indicator.setRecording(true);
        this._ui = ui;
    }

    // GNOME's recorder is running: red dot, timer, and the red glow around each monitor.
    _showRecording() {
        const ui = this._ui;
        ui.pill.setState('recording');
        ui.pill.setTime((now() - this._session.t0) / 1e6);
        ui.pill.setMicLevel(0);
        // Mic level bar, about 10 updates a second (skipped while a call is still out).
        let asking = false;
        ui.meter = GLib.timeout_add(GLib.PRIORITY_DEFAULT, METER_MS, () => {
            if (!asking) {
                asking = true;
                service('MicLevel', null, '(d)')
                    .then(([level]) => this._ui === ui && ui.pill.setMicLevel(level))
                    .catch(logError)
                    .finally(() => (asking = false));
            }
            return GLib.SOURCE_CONTINUE;
        });
        // Warn while the mic hears only silence (muted, wrong device), so the capture
        // isn't wasted. The service checks the last few seconds of the recording.
        ui.micCheck = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            service('MicSilent', null, '(b)')
                .then(([silent]) => this._ui === ui && ui.pill.setMicSilent(silent))
                .catch(logError);
            return GLib.SOURCE_CONTINUE;
        });
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
            Main.uiGroup.insert_child_below(g, ui.ink.actor);
            return g;
        });
    }

    _hideUi() {
        const ui = this._ui;
        if (!ui)
            return;
        this._ui = null;
        this._stroke = null;
        this._releaseGrab();
        for (const id of [ui.clock, ui.poll, ui.meter, ui.micCheck])
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

    // Switches the catcher on/off while Shift is held and logs plain clicks anywhere.
    // A stage grab routes the pointer to the catcher immediately; just flipping `reactive`
    // would only take effect after the next repaint, and a quick Shift+click would miss.
    // The grab also holds keys, so text typed with Shift doesn't reach apps meanwhile.
    _poll() {
        const [x, y, mods] = global.get_pointer();
        const down = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
        const shift = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
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
        if (type === Clutter.EventType.KEY_PRESS || type === Clutter.EventType.KEY_RELEASE)
            return Clutter.EVENT_STOP;      // keys typed with Shift held: keep them from apps
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
            // Shift+click: turn it into a pin.
            item.points = null;
            Object.assign(item, {x: x0, y: y0});
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
}
