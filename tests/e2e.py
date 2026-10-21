#!/usr/bin/env python3
"""End-to-end test in a throwaway headless GNOME Shell (your real session is untouched).

    tests/e2e.py speech.wav

Starts `gnome-shell --headless` on its own session bus with its own dconf, enables the
extension there, plays speech into a virtual microphone, and drives real keyboard/pointer
input through Mutter's RemoteDesktop API:

  capture 1: Alt+Shift+S, two strokes, two clicks, a Space-click pin, a stroke that is
             undone with Ctrl+Z, then Alt+Shift+S to finish.
  capture 2: Alt+Shift+S, one stroke, click Finish in the pill.
  capture 3: Alt+Shift+S, Esc before the recording has started, Alt+Shift+S again at
             once, one stroke, Alt+Shift+S. The cancel must not clobber the new capture.

Then it opens paste_target.py and checks that Ctrl+V pastes the newest capture's notes
and contact sheet, that Alt+Shift+V does too, and that Ctrl+V is normal after a copy.

Then waits for the three bundles and checks their contents. Needs install.sh to have
linked the extension and the D-Bus service file.
"""
import json
import os
import subprocess
import sys
import time

if os.environ.get('SKETCHNOTE_E2E') != 'inner':
    # Re-run inside a private session bus, with a private dconf database.
    tmp = '/tmp/sketchnote-e2e'
    os.makedirs(f'{tmp}/config', exist_ok=True)
    env = dict(os.environ, SKETCHNOTE_E2E='inner', XDG_CONFIG_HOME=f'{tmp}/config',
               SKETCHNOTE_MIC_TARGET='sketchnote-e2e-mic')
    env.pop('DBUS_SESSION_BUS_ADDRESS', None)
    sys.exit(subprocess.call(['dbus-run-session', '--', sys.executable, *sys.argv], env=env))

from gi.repository import Gio, GLib  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SPEECH = sys.argv[1]                # ~30 s WAV of someone talking
DISPLAY = 'sketchnote-e2e'
bus = Gio.bus_get_sync(Gio.BusType.SESSION)

KEY = {'shift': 0xffe1, 'alt': 0xffe9, 'ctrl': 0xffe3, 's': 0x73, 'z': 0x7a, 'esc': 0xff1b,
       'space': 0x20, 'v': 0x76, 'c': 0x63}
BTN_LEFT = 0x110


def call(dest, path, iface, method, args=None, sig=None):
    r = bus.call_sync(dest, path, iface, method, args, GLib.VariantType(sig) if sig else None,
                      Gio.DBusCallFlags.NONE, 10000, None)
    return r.unpack() if r else None


def wait_for(check, what, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if check():
                return
        except GLib.Error:
            pass
        time.sleep(0.5)
    raise SystemExit(f'timed out waiting for {what}')


class Input:
    """Keyboard and absolute pointer input via org.gnome.Mutter.RemoteDesktop."""

    def __init__(self):
        rd = '/org/gnome/Mutter/RemoteDesktop'
        (self.rd,) = call('org.gnome.Mutter.RemoteDesktop', rd, 'org.gnome.Mutter.RemoteDesktop',
                          'CreateSession', None, '(o)')
        sid = call('org.gnome.Mutter.RemoteDesktop', self.rd, 'org.freedesktop.DBus.Properties',
                   'Get', GLib.Variant('(ss)', ('org.gnome.Mutter.RemoteDesktop.Session',
                                                'SessionId')), '(v)')[0]
        (sc,) = call('org.gnome.Mutter.ScreenCast', '/org/gnome/Mutter/ScreenCast',
                     'org.gnome.Mutter.ScreenCast', 'CreateSession',
                     GLib.Variant('(a{sv})', ({'remote-desktop-session-id': GLib.Variant('s', sid)},)),
                     '(o)')
        state = call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                     'org.gnome.Mutter.DisplayConfig', 'GetCurrentState')
        connector = state[1][0][0][0]
        (self.stream,) = call('org.gnome.Mutter.ScreenCast', sc,
                              'org.gnome.Mutter.ScreenCast.Session', 'RecordMonitor',
                              GLib.Variant('(sa{sv})', (connector, {})), '(o)')
        node = []
        bus.signal_subscribe(None, 'org.gnome.Mutter.ScreenCast.Stream', 'PipeWireStreamAdded',
                             self.stream, None, Gio.DBusSignalFlags.NONE,
                             lambda *a: node.append(a[5].unpack()[0]))
        self._rd('Start')
        ctx = GLib.MainContext.default()
        end = time.time() + 10
        while not node and time.time() < end:
            ctx.iteration(False)
            time.sleep(0.01)
        self.node = node[0]
        time.sleep(0.5)

    def screenshot(self, path):
        """One frame of the virtual monitor, read from the RemoteDesktop PipeWire stream."""
        subprocess.run(['gst-launch-1.0', '-q', 'pipewiresrc', f'path={self.node}',
                        'always-copy=true', 'num-buffers=1', '!', 'videoconvert', '!', 'pngenc',
                        '!', 'filesink', f'location={path}'], check=True, timeout=20)

    def _rd(self, method, args=None):
        call('org.gnome.Mutter.RemoteDesktop', self.rd, 'org.gnome.Mutter.RemoteDesktop.Session',
             method, args)

    def key(self, name, down):
        self._rd('NotifyKeyboardKeysym', GLib.Variant('(ub)', (KEY[name], down)))

    def combo(self, *names):
        for n in names:
            self.key(n, True)
        time.sleep(0.05)
        for n in reversed(names):
            self.key(n, False)
        time.sleep(0.1)

    def move(self, x, y):
        self._rd('NotifyPointerMotionAbsolute', GLib.Variant('(sdd)', (self.stream, x, y)))
        time.sleep(0.016)

    def button(self, down):
        self._rd('NotifyPointerButton', GLib.Variant('(ib)', (BTN_LEFT, down)))
        time.sleep(0.03)

    def click(self, x, y):
        self.move(x, y)
        self.button(True)
        self.button(False)

    def drag(self, points, space=True):
        if space:
            self.key('space', True)
            time.sleep(0.05)
        self.move(*points[0])
        self.button(True)
        for p in points[1:]:
            self.move(*p)
        self.button(False)
        if space:
            self.key('space', False)


def ellipse(cx, cy, rx, ry, n=40):
    import math
    return [(cx + rx * math.cos(2 * math.pi * i / n), cy + ry * math.sin(2 * math.pi * i / n))
            for i in range(n + 1)]


def line(x0, y0, x1, y1, n=20):
    return [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n + 1)]


def at(t0, t):
    time.sleep(max(0, t0 + t - time.time()))


def latest_bundles():
    root = os.path.expanduser('~/.local/share/sketchnote/captures')
    return set(os.listdir(root)) if os.path.isdir(root) else set()


def main():
    procs = []
    try:
        subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions',
                        "['sketchnote@local']"], check=True)
        subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'welcome-dialog-last-shown-version',
                        "'999'"], check=True)
        log = open('/tmp/sketchnote-e2e/shell.log', 'w')
        procs.append(subprocess.Popen(['gnome-shell', '--headless', '--wayland', '--no-x11',
                                       '--virtual-monitor', '1920x1080',
                                       '--wayland-display', DISPLAY], stdout=log, stderr=log))
        wait_for(lambda: call('org.gnome.Shell', '/org/gnome/Shell',
                              'org.gnome.Shell.Extensions', 'GetExtensionInfo',
                              GLib.Variant('(s)', ('sketchnote@local',)))[0]['state'] == 1,
                 'extension to be active')
        print('shell up, extension active')

        # Virtual mic: a sink we play into, looped back to a source the service records.
        procs.append(subprocess.Popen(['pw-loopback',
            '--capture-props=media.class=Audio/Sink node.name=sketchnote-e2e-sink audio.channels=1',
            '--playback-props=media.class=Audio/Source node.name=sketchnote-e2e-mic audio.channels=1']))
        # A real window to point at.
        sample = '/tmp/sketchnote-e2e/notes.txt'
        with open(sample, 'w') as f:
            f.write('Sketchnote end-to-end test\n\n' + '\n'.join(
                f'Line {i}: the footer here is too wordy and the model name is old.' for i in range(30)))
        procs.append(subprocess.Popen(['gnome-text-editor', '--standalone', sample],
                                      env=dict(os.environ, WAYLAND_DISPLAY=DISPLAY, GDK_BACKEND='wayland')))
        time.sleep(4)
        inp = Input()
        inp.combo('esc')            # leave the startup overview if it is showing
        time.sleep(1)

        before = latest_bundles()
        # --- capture 1: hotkey, strokes, clicks, pin, undo, hotkey ---------------
        inp.move(960, 540)
        inp.combo('alt', 'shift', 's')
        t0 = time.time() + 0.5
        at(t0, 0)
        procs.append(subprocess.Popen(['pw-play', '--target', 'sketchnote-e2e-sink', SPEECH]))
        at(t0, 4.0)
        inp.drag(ellipse(700, 400, 160, 40))
        at(t0, 10.2)
        inp.drag(ellipse(900, 600, 300, 150, 60))
        at(t0, 11.5)
        inp.click(820, 520)
        at(t0, 14.4)
        inp.click(860, 560)
        at(t0, 21.6)
        inp.drag([(1100, 450), (1101, 451)])                 # Space+click = pin
        at(t0, 25.7)
        inp.drag(line(600, 700, 900, 705))
        at(t0, 27.5)
        inp.drag(line(400, 300, 1400, 800))                  # mistake...
        time.sleep(0.3)
        inp.combo('ctrl', 'z')                               # ...undone
        at(t0, 31)
        inp.combo('alt', 'shift', 's')
        print('capture 1 finished')
        time.sleep(3)

        # --- capture 2: draw, click Finish ------------------------------------------
        inp.combo('alt', 'shift', 's')
        time.sleep(2.5)
        inp.drag(ellipse(900, 500, 120, 50))
        time.sleep(2.5)
        inp.screenshot('/tmp/sketchnote-e2e/pill-actions.png')
        fx, fy = finish_button('/tmp/sketchnote-e2e/pill-actions.png')
        inp.click(fx, fy)
        print('capture 2 finished')
        time.sleep(2)

        # --- capture 3: cancel while the recording is still starting, start again ---
        inp.combo('alt', 'shift', 's')
        time.sleep(0.2)
        inp.combo('esc')
        time.sleep(0.2)
        inp.combo('alt', 'shift', 's')
        time.sleep(2.5)
        inp.drag(ellipse(900, 500, 120, 50))
        time.sleep(1.5)
        inp.combo('alt', 'shift', 's')
        print('capture 3 finished')

        def done():
            new = sorted(latest_bundles() - before)
            root = os.path.expanduser('~/.local/share/sketchnote/captures')
            return len(new) == 3 and all(
                os.path.exists(f'{root}/{n}/summary.md') for n in new)
        wait_for(done, 'three bundles', timeout=300)
        first, second, third = [os.path.expanduser(f'~/.local/share/sketchnote/captures/{n}')
                         for n in sorted(latest_bundles() - before)]
        d1 = check_bundle(first)
        assert [m['type'] for m in d1['marks']] == \
            ['stroke', 'stroke', 'click', 'click', 'pin', 'stroke'], 'capture 1 marks'
        assert d1['words'], 'capture 1 has speech'
        d2 = check_bundle(second)
        assert d2['area'] == [0, 0, 1920, 1080], d2['area']
        assert [m['type'] for m in d2['marks']] == ['stroke'], 'capture 2 marks'
        d3 = check_bundle(third)
        assert [m['type'] for m in d3['marks']] == ['stroke'], 'capture 3 marks'
        check_paste(inp, third, procs)
        print('\nE2E OK')
    finally:
        for p in reversed(procs):
            p.terminate()
        for p in procs:
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()


def check_paste(inp, bundle_dir, procs):
    from PIL import Image
    log = '/tmp/sketchnote-e2e/pastes.log'
    open(log, 'w').close()
    procs.append(subprocess.Popen([sys.executable, f'{HERE}/paste_target.py', log],
                                  env=dict(os.environ, WAYLAND_DISPLAY=DISPLAY, GDK_BACKEND='wayland')))
    time.sleep(3)
    lines = lambda: open(log).read().splitlines()  # noqa: E731
    notes = 'text ' + open(f'{bundle_dir}/summary.md').read().splitlines()[0]
    image = 'image {}x{}'.format(*Image.open(f'{bundle_dir}/contact-sheet.png').size)

    inp.combo('ctrl', 'v')
    wait_for(lambda: len(lines()) >= 2, 'Ctrl+V to paste notes and image', timeout=10)
    inp.combo('alt', 'shift', 'v')
    wait_for(lambda: len(lines()) >= 4, 'Alt+Shift+V to paste notes and image', timeout=10)
    inp.combo('c')                      # the app copies "other"...
    time.sleep(0.5)
    inp.combo('ctrl', 'v')              # ...so Ctrl+V pastes just that
    wait_for(lambda: len(lines()) >= 5, 'a plain Ctrl+V', timeout=10)
    time.sleep(1)
    print('\n== pastes\n' + '\n'.join(lines()))
    assert lines() == [notes, image, notes, image, 'text other'], lines()


def finish_button(path):
    """Centre of the pill's Finish button: the rightmost part of the dark capsule."""
    from PIL import Image
    img = Image.open(path).convert('RGB')
    w = img.width
    y = 32 + 8 + 16                    # panel height + margin + half the pill height
    # dark capsule pixels along the pill's middle row
    xs = [x for x in range(w) if sum(img.getpixel((x, y))) < 120 and
          abs(x - w // 2) < 400]
    left, right = min(xs), max(xs)
    return right - 40, y


def check_bundle(path):
    print(f'\n== {path}')
    names = sorted(os.listdir(path))
    print('  files:', names)
    for f in ['recording.mp4', 'audio.wav', 'contact-sheet.png', 'summary.md',
              'sketchnote.json', 'frames', 'frames-full']:
        assert f in names, f'missing {f}'
    data = json.load(open(f'{path}/sketchnote.json'))
    print('  marks:', [(m['n'], m['type'], round(m['t'], 1)) for m in data['marks']])
    print('  words:', len(data['words']))
    print(open(f'{path}/summary.md').read())
    return data


if __name__ == '__main__':
    main()
