"""Pack the standalone page for T3's 512 KB inline HTML limit."""
from pathlib import Path
import base64
import gzip

here = Path(__file__).parent
source = (here / 'sketchnote.html').read_text().replace(
    '.iso-page{width:min(1080px,100% - 32px);margin:64px auto 96px}',
    '.iso-page{width:100%;margin:0 auto 12px}',
)
payload = base64.b64encode(gzip.compress(source.encode())).decode()
page = '''<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}iframe{width:100%;border:0;display:block;height:1200px}</style></head><body><iframe title="Sketchnote anatomy"></iframe><script>
(async()=>{const bytes=Uint8Array.from(atob("PAYLOAD"),c=>c.charCodeAt(0));const html=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();const f=document.querySelector('iframe');f.onload=()=>{const resize=()=>f.style.height=f.contentDocument.documentElement.scrollHeight+'px';new ResizeObserver(resize).observe(f.contentDocument.body);resize()};f.srcdoc=html})();</script></body></html>'''
(here / 'inline-preview.html').write_text(page.replace('PAYLOAD', payload))
