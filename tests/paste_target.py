#!/usr/bin/env python3
"""A window that logs what each Ctrl+V pastes, for e2e.py. Usage: paste_target.py LOG

Each paste appends one line to LOG: "text <first line>" or "image <width>x<height>".
Pressing C copies the text "other" (to check Ctrl+V is normal again after a copy).
"""
import sys

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
from gi.repository import Gdk, Gtk  # noqa: E402

LOG = sys.argv[1]


def log(line):
    with open(LOG, 'a') as f:
        f.write(line + '\n')


def on_key(_ctrl, keyval, _code, state):
    clipboard = Gdk.Display.get_default().get_clipboard()
    if keyval == Gdk.KEY_v and state & Gdk.ModifierType.CONTROL_MASK:
        if clipboard.get_formats().contain_mime_type('image/png'):
            def got_image(c, result):
                texture = c.read_texture_finish(result)
                log(f'image {texture.get_width()}x{texture.get_height()}')
            clipboard.read_texture_async(None, got_image)
        else:
            clipboard.read_text_async(None, lambda c, r: log(
                'text ' + c.read_text_finish(r).splitlines()[0]))
        return True
    if keyval == Gdk.KEY_c:
        clipboard.set('other')
        return True
    return False


def on_activate(app):
    win = Gtk.ApplicationWindow(application=app, title='paste target')
    win.set_default_size(400, 300)
    keys = Gtk.EventControllerKey()
    keys.connect('key-pressed', on_key)
    win.add_controller(keys)
    win.present()


app = Gtk.Application(application_id='org.sketchnote.PasteTarget')
app.connect('activate', on_activate)
app.run([])
