"""Session D-Bus service the GNOME Shell extension talks to.

    Start()        -> new bundle dir; starts recording the microphone into it
    Finish(json)   -> bundle dir; stops the mic and builds the bundle in the background
    Cancel()       -> stops the mic and deletes the bundle dir
    signal BundleReady(path) when a bundle is finished (also a desktop notification)

Started on demand by D-Bus activation (see install.sh).
"""
import json
import os
import shutil
import signal
import subprocess
import threading
import time
import traceback

from gi.repository import Gio, GLib

import bundle

NAME = 'org.sketchnote.Service'
PATH = '/org/sketchnote/Service'
CAPTURES = os.path.join(GLib.get_user_data_dir(), 'sketchnote', 'captures')

XML = f"""<node><interface name="{NAME}">
  <method name="Start"><arg type="s" direction="out"/></method>
  <method name="Finish"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="Cancel"/>
  <signal name="BundleReady"><arg type="s"/></signal>
</interface></node>"""


class Service:
    def __init__(self, conn):
        self.conn = conn
        self.dir = None
        self.mic = None
        self.mic_t0 = 0

    def call(self, method, args):
        if method == 'Start':
            return GLib.Variant('(s)', (self.start(),))
        if method == 'Finish':
            return GLib.Variant('(s)', (self.finish(json.loads(args[0])),))
        if method == 'Cancel':
            self.cancel()
            return None

    def start(self):
        self.cancel()
        self.dir = os.path.join(CAPTURES, time.strftime('%Y-%m-%d_%H-%M-%S') + '.bundle')
        os.makedirs(self.dir)
        cmd = ['pw-record', '--rate', '16000', '--channels', '1', '--format', 's16']
        if os.environ.get('SKETCHNOTE_MIC_TARGET'):     # e.g. a test source
            cmd += ['--target', os.environ['SKETCHNOTE_MIC_TARGET']]
        self.mic = subprocess.Popen(cmd + [os.path.join(self.dir, 'audio.wav')])
        self.mic_t0 = time.monotonic_ns() // 1000      # same clock as GLib.get_monotonic_time
        return self.dir

    def stop_mic(self):
        if self.mic:
            self.mic.send_signal(signal.SIGINT)        # lets pw-record finish the WAV header
            try:
                self.mic.wait(5)
            except subprocess.TimeoutExpired:
                self.mic.kill()
            self.mic = None

    def finish(self, capture):
        if not self.dir:
            raise RuntimeError('no capture in progress')
        self.stop_mic()
        bundle_dir, mic_t0 = self.dir, self.mic_t0
        self.dir = None
        threading.Thread(target=self.build, args=(bundle_dir, capture, mic_t0), daemon=True).start()
        return bundle_dir

    def build(self, bundle_dir, capture, mic_t0):
        try:
            bundle.build(bundle_dir, capture, mic_t0)
            n = sum(1 for _ in os.scandir(os.path.join(bundle_dir, 'frames')))
            notify('Sketchnote ready', f'{n} notes · Alt+Shift+V pastes the text, '
                                       'Alt+Shift+I the contact sheet')
            GLib.idle_add(self.conn.emit_signal, None, PATH, NAME, 'BundleReady',
                          GLib.Variant('(s)', (bundle_dir,)))
        except Exception:
            traceback.print_exc()
            notify('Sketchnote failed', f'Could not build {bundle_dir}; see the journal')

    def cancel(self):
        self.stop_mic()
        if self.dir:
            shutil.rmtree(self.dir, ignore_errors=True)
            self.dir = None


def notify(title, body):
    subprocess.run(['notify-send', '--app-name=Sketchnote', title, body], check=False)


def run():
    loop = GLib.MainLoop()
    info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]

    def on_bus(conn, _name):
        service = Service(conn)

        def on_call(_conn, _sender, _path, _iface, method, params, invocation):
            try:
                invocation.return_value(service.call(method, params.unpack()))
            except Exception as e:
                traceback.print_exc()
                invocation.return_dbus_error(f'{NAME}.Error', str(e))

        conn.register_object(PATH, info, on_call, None, None)
        # Never leave the mic running if the Shell (and so the capture UI) goes away.
        Gio.bus_watch_name(Gio.BusType.SESSION, 'org.gnome.Shell', Gio.BusNameWatcherFlags.NONE,
                           None, lambda *_: service.cancel())

        def on_term():
            service.cancel()
            loop.quit()
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, on_term)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, on_term)

    Gio.bus_own_name(Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.NONE,
                     on_bus, None, lambda *_: loop.quit())
    loop.run()
