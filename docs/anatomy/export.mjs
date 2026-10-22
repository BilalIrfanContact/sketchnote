// Render the same tour used in the browser, then make a small README GIF.
// Requires Chrome/Chromium and ffmpeg. No npm dependencies.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] || join(here, '../images/anatomy-light.gif'));
const cache = join(homedir(), '.cache/ms-playwright');
const cachedChrome = existsSync(cache) ? readdirSync(cache).sort().reverse()
  .flatMap(name => ['chrome-linux64/chrome', 'chrome-linux/chrome'].map(path => join(cache, name, path))) : [];
const chromePath = process.env.CHROME_PATH || [
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
  ...cachedChrome,
].find(p => existsSync(p));
if (!chromePath) throw new Error('Set CHROME_PATH to your Chrome or Chromium executable.');
const temp = mkdtempSync(join(tmpdir(), 'sketchnote-tour-'));
const shots = join(here, 'shots');
mkdirSync(shots, { recursive: true });
mkdirSync(dirname(output), { recursive: true });
const fps = 25;
const chrome = spawn(chromePath, [
  '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=0', `--user-data-dir=${join(temp, 'profile')}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
try {
  const port = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 20000);
    chrome.on('error', e => { clearTimeout(timer); reject(e); });
    chrome.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited: ${code}`)); });
    chrome.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.enable'); await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1048, height: 850, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: pathToFileURL(join(here, 'sketchnote-tour-light.html')).href });
  for (let n = 0; n < 100; n++) {
    if (await evaluate('Boolean(window.sketchnoteTour)')) break;
    if (n === 99) throw new Error('Tour did not load');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await evaluate('document.fonts.ready.then(() => window.sketchnoteTour.seek(0.5))');
  const { duration, count } = await evaluate('({duration:sketchnoteTour.duration, count:sketchnoteTour.stops.length})');
  const clip = await evaluate(`(() => {
    const r = document.querySelector('.sn-stage').getBoundingClientRect();
    return {x:r.x+scrollX, y:r.y+scrollY, width:r.width, height:r.height, scale:1};
  })()`);
  async function capture(seconds) {
    await evaluate(`window.sketchnoteTour.seek(${seconds})`);
    const { data } = await call('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    return Buffer.from(data, 'base64');
  }
  for (let i = 0; i < count; i++) {
    writeFileSync(join(shots, `tour-${String(i + 1).padStart(2, '0')}.png`), await capture(i * 2.8 + 1));
  }
  writeFileSync(join(here, '../images/anatomy-light.png'), await capture(6.6));
  const frames = Math.round(duration * fps);
  for (let i = 0; i < frames; i++) {
    writeFileSync(join(temp, `${String(i).padStart(4, '0')}.png`), await capture(i / fps));
    if (i % 100 === 0) console.log(`Rendered ${i}/${frames} frames`);
  }
  if (errors.length) throw new Error(`Browser errors: ${JSON.stringify(errors)}`);
  const run = args => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}`);
  };
  const palette = join(temp, 'palette.png');
  const input = ['-framerate', String(fps), '-i', join(temp, '%04d.png')];
  run([...input, '-vf', 'palettegen=max_colors=64:stats_mode=diff', '-frames:v', '1', palette]);
  run([...input, '-i', palette, '-lavfi', 'paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', output]);
  const bytes = readFileSync(output).length;
  console.log(JSON.stringify({ output, duration, fps, frames, bytes, width:clip.width, height:clip.height, browserErrors:errors.length }));
} finally {
  if (ws) ws.close();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill('SIGKILL');
    await exited;
  }
  rmSync(temp, { recursive: true, force: true });
}
