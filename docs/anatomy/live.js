(() => {
  const $ = s => document.querySelector(s), all = s => [...document.querySelectorAll(s)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let index=0, mode='local', time=0, playing=!reduced.matches, visible=true, last=0, picked=null;
  const controls=$('.sn-controls');
  controls.insertAdjacentHTML('beforeend','<p class="sn-status"><button class="sn-play" type="button">Pause tour</button> <span>Illustrative sequence, not measured processing time.</span></p><label>Inspect a part<select class="sn-inspect" aria-label="Inspect a part"><option value="">Current step</option></select></label>');
  const select=$('.sn-inspect');
  Object.entries(PARTS).forEach(([id,p])=>{const o=document.createElement('option');o.value=id;o.textContent=p.name+' · '+p.role;select.append(o)});
  const matches = m => !m || m.split(/\s+/).includes(mode);
  const active=(spec)=>spec.trim().split(/\s+/).some(v=>{const [id,t]=v.split('@');return (id==='*' && !spec.includes(STEPS[index].id+'@')) || (id===STEPS[index].id && time>=Number(t||0))});
  function info(id){picked=id;const p=PARTS[id]; $('[data-info-name]').textContent=p?p.name:STEPS[index].label; $('[data-info-role]').textContent=p?p.role:'the film crew';$('[data-info-text]').textContent=p?p.text:STEPS[index].text;all('[data-part]').forEach(e=>e.classList.toggle('is-picked',e.dataset.part===id));}
  const latest=(rows)=> (rows||[]).filter(r=>time>=r[0] && matches(r[2])).at(-1);
  const clamp=x=>Math.max(0,Math.min(1,x));
  function go(i){index=(i+STEPS.length)%STEPS.length;time=playing?0:STEPS[index].dur-.01;info(null);select.value='';render();}
  function render(){const s=STEPS[index];
    all('[data-go]').forEach(e=>e.setAttribute('aria-pressed',String(e.dataset.go===s.id)));
    all('[data-mode]').forEach(e=>e.setAttribute('aria-pressed',String(e.dataset.mode===mode)));
    all('[data-when]').forEach(e=>e.style.display=active(e.dataset.when)?'':'none');
    all('[data-mode-when]').forEach(e=>e.style.display=matches(e.dataset.modeWhen)?'':'none');
    all('[data-part]').forEach(e=>e.classList.toggle('is-lit',(s.lit||[]).some(([id,a,b,m])=>id===e.dataset.part&&time>=a&&time<=b&&matches(m))));
    all('[data-key]').forEach(e=>{const down=(s.keys||[]).some(([id,a,b])=>id===e.dataset.key&&time>=a&&time<b);e.style.opacity=down?'.5':'1'});
    const recording=['record','draw'].includes(s.id);
    $('.sn-glow').style.opacity=recording?'1':'0';$('.sn-tally').style.opacity=recording?'1':'0';
    let pill=(s.pill||[]).filter(r=>r[0]<=time).at(-1);const pt=$('[data-pill-text]');
    $('[data-pill]').style.opacity=pill&&pill[1]!=='hidden'?'1':'0';pt.textContent=pill?pill[2]:'';
    if(recording)pt.textContent='Recording 0:'+String(Math.floor(time+3)).padStart(2,'0');
    if(s.id==='ready'&&mode==='fail'&&time>=1.1)pt.textContent='Ready (local model)';
    all('[data-meter]').forEach(e=>e.style.opacity=recording?String(.3+.7*Math.abs(Math.sin(time*5))):'.2');
    const draw=s.id==='draw', ink=draw?clamp((time-.2)/1.6):0;
    $('[data-ink=loop]').style.strokeDashoffset=String(1-ink);$('[data-ink=loop]').style.opacity=draw?String(1-clamp((time-2.3))):'0';$('[data-ink=pin]').style.opacity=draw&&time>=2.8?String(1-clamp(time-3.3)):'0';
    const sheet=latest(s.sheet)?.[1]||'notes';all('[data-clip-sheet]').forEach(e=>e.style.display=e.dataset.clipSheet===sheet?'':'none');
    all('[data-lever]').forEach(e=>e.style.display=e.dataset.lever===(mode==='local'?'local':'api')?'':'none');
    all('[data-spin]').forEach(e=>e.setAttribute('transform',`rotate(${(recording||s.id==='build')?time*60:0})`));
    const pulse=(s.pulses||[]).find(([a,b])=>time>=a&&time<=b);const dot=$('[data-pulse=dbus]');dot.style.opacity=pulse?'1':'0';if(pulse){let f=(time-pulse[0])/(pulse[1]-pulse[0]);if(pulse[2]==='in')f=1-f;const route=$('#sn-dbus-path');const p=route.getPointAtLength(f*route.getTotalLength());dot.setAttribute('transform',`translate(${p.x} ${p.y})`)}
    const token=$('[data-token=api]');const sending=s.id==='build'&&mode!=='local'&&time>=2.4&&time<=3.4;token.style.opacity=sending?'1':'0';if(sending){const route=$('#sn-api-path');const p=route.getPointAtLength(clamp(time-2.4)*route.getTotalLength());token.setAttribute('transform',`translate(${p.x} ${p.y})`)}
    const say=latest(s.say);$('[data-corner=readout]').textContent=say?say[1]:s.label;
    $('.sn-play').textContent=playing?'Pause tour':'Play tour';
  }
  all('[data-go]').forEach(e=>e.addEventListener('click',()=>go(STEPS.findIndex(s=>s.id===e.dataset.go))));
  all('[data-mode]').forEach(e=>e.addEventListener('click',()=>{mode=e.dataset.mode;time=0;render()}));
  $('.sn-play').addEventListener('click',()=>{playing=!playing;render()});
  select.addEventListener('change',()=>{info(select.value||null);playing=false;render()});
  all('[data-part]').forEach(e=>{const p=PARTS[e.dataset.part];if(!p)return;e.setAttribute('tabindex','0');e.setAttribute('role','button');e.setAttribute('aria-label',p.name);e.addEventListener('pointerenter',()=>info(e.dataset.part));e.addEventListener('focus',()=>info(e.dataset.part));e.addEventListener('click',()=>{info(e.dataset.part);select.value=e.dataset.part;playing=false;render()});e.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();e.dispatchEvent(new Event('click'))}})});
  $('.sn-stage').addEventListener('keydown',e=>{if(e.key==='ArrowRight'){e.preventDefault();go(index+1)}if(e.key==='ArrowLeft'){e.preventDefault();go(index-1)}});
  new IntersectionObserver(([e])=>visible=e.isIntersecting).observe($('.sn-stage'));
  reduced.addEventListener('change',()=>{if(reduced.matches)playing=false;render()});
  function tick(now){const dt=Math.min((now-last)/1000,.1);last=now;if(playing&&visible&&!document.hidden){time+=dt;if(time>STEPS[index].dur){go(index+1)}render()}requestAnimationFrame(tick)}
  // A deterministic entry point shared by the labeled tour and its frame exporter.
  window.sketchnoteScene = {
    seek(id, seconds) {
      const next = STEPS.findIndex(s => s.id === id);
      if (next < 0) throw new Error(`Unknown capture step: ${id}`);
      playing = false; index = next; time = seconds;
      info(null); render();
    }
  };
  go(0);requestAnimationFrame(tick);
})();
