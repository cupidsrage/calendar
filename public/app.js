/* ============ boot / routing ============ */
async function boot(){
  clearInterval(pollTimer);
  applyTheme();
  setOnline();
  const state = await api('/api/state');
  if (state.needsSetup) return renderSetup();
  if (!token || !me) return renderLogin(state.parents, state.kidLogins || []);
  await refresh();
  renderApp();
  // Poll while the app is actually on screen; pause in the background to save battery.
  pollTimer = setInterval(async ()=>{
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    // Don't rebuild the UI while a sheet is open — it would wipe a half-typed form.
    if (document.querySelector('.sheet.open')) return;
    try{ await refresh(); renderApp(true); }catch(e){}
  }, 25000);
}

async function refresh(){ D = await api('/api/data?month='+monthKey(view)); }

/* ============ setup ============ */
function renderSetup(){
  const colors=['#2F6D62','#C0702A','#4A5FA5','#8A4E7D','#5E7C3A','#A3543B'];
  $('#app').innerHTML = `
  <div class="gate"><div class="gate-card">
    <h1 class="display">Set up your calendar</h1>
    <p class="sub">One-time setup. Each parent gets a name, a color, and a PIN for signing in.</p>
    <div class="parent-setup">
      ${[0,1].map(i=>`
      <div class="parent-box">
        <h3>Parent ${i+1}</h3>
        <div class="field"><label>Name</label><input id="s-name-${i}" placeholder="${i===0?'e.g. Blake':'e.g. Sam'}"></div>
        <div class="field"><label>Email (for notifications)</label><input id="s-email-${i}" type="email" placeholder="name@email.com"></div>
        <div class="field"><label>Color</label>
          <div class="swatches" id="s-col-${i}">
            ${colors.map((c,j)=>`<button type="button" class="swatch ${j===i?'sel':''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}
          </div>
        </div>
        <div class="field"><label>PIN (4+ digits)</label><input id="s-pin-${i}" type="password" inputmode="numeric" placeholder="••••"></div>
      </div>`).join('')}
    </div>
    <div class="field" style="margin-top:14px"><label>Kids (comma separated)</label><input id="s-kids" placeholder="e.g. Ava, Max"></div>
    <button class="btn primary" id="s-go" style="width:100%">Create calendar</button>
    <div class="err" id="s-err"></div>
  </div></div>`;
  document.querySelectorAll('.swatches').forEach(w=>{
    w.addEventListener('click',e=>{
      const b=e.target.closest('.swatch'); if(!b) return;
      w.querySelectorAll('.swatch').forEach(x=>x.classList.remove('sel')); b.classList.add('sel');
    });
  });
  $('#s-go').onclick = async ()=>{
    const parents=[0,1].map(i=>({
      name: $(`#s-name-${i}`).value.trim(),
      email: $(`#s-email-${i}`).value.trim(),
      pin: $(`#s-pin-${i}`).value.trim(),
      color: $(`#s-col-${i} .sel`).dataset.c
    }));
    const kids = $('#s-kids').value.split(',').map(s=>s.trim()).filter(Boolean);
    try{ await api('/api/setup',{method:'POST',body:{parents,kids}}); boot(); }
    catch(e){ $('#s-err').textContent = e.error || 'Setup failed'; }
  };
}

/* ============ login ============ */
function renderLogin(parents, kidLogins){
  kidLogins = kidLogins || [];
  let mode = 'parent';                 // 'parent' | 'kid'
  let sel = parents[0]?.id;
  let kidSel = kidLogins[0]?.id;

  const draw = ()=>{
    const people = mode==='parent' ? parents : kidLogins;
    const cur = mode==='parent' ? sel : kidSel;
    $('#app').innerHTML = `
    <div class="gate"><div class="gate-card" style="max-width:420px">
      <h1 class="display">Our Calendar</h1>
      <p class="sub">Who's signing in?</p>
      <div class="login-choice">
        ${people.map(p=>`
        <button class="login-parent ${p.id===cur?'sel':''}" data-id="${p.id}" style="border-color:${p.id===cur&&p.color?p.color:''}">
          <span class="dot" style="background:${p.color||'#8a8f84'}"></span>${esc(p.name)}
        </button>`).join('') || `<p class="sub" style="margin:4px 0 0">No kid logins set up yet. A parent can add them in settings.</p>`}
      </div>
      <div class="field"><label>PIN</label><input id="l-pin" type="password" inputmode="numeric" placeholder="••••"></div>
      <button class="btn primary" id="l-go" style="width:100%">Sign in</button>
      <div class="err" id="l-err"></div>
      ${kidLogins.length ? `<button class="linkbtn" id="l-switch" style="margin-top:14px;width:100%">
        ${mode==='parent' ? "I'm a kid — view only" : "I'm a parent"}
      </button>` : ''}
    </div></div>`;

    document.querySelectorAll('.login-parent').forEach(b=>{
      b.onclick=()=>{
        const id=+b.dataset.id;
        if(mode==='parent'){ sel=id; } else { kidSel=id; }
        document.querySelectorAll('.login-parent').forEach(x=>{x.classList.remove('sel'); x.style.borderColor='';});
        b.classList.add('sel');
        const c = (mode==='parent'?parents:kidLogins).find(p=>p.id===id)?.color;
        if(c) b.style.borderColor=c;
      };
    });

    const go = async ()=>{
      try{
        if(mode==='parent'){
          const r = await api('/api/login',{method:'POST',body:{parent_id:sel,pin:$('#l-pin').value}});
          token=r.token; me=r.parent;
        } else {
          const r = await api('/api/kid-login',{method:'POST',body:{kid_id:kidSel,pin:$('#l-pin').value}});
          token=r.token; me={ id:r.kid.id, name:r.kid.name, kid:true };
        }
        localStorage.setItem('cc_token',token); localStorage.setItem('cc_me',JSON.stringify(me));
        boot();
      }catch(e){ $('#l-err').textContent=e.error||'Sign in failed'; }
    };
    $('#l-go').onclick=go;
    $('#l-pin').addEventListener('keydown',e=>{ if(e.key==='Enter') go(); });
    const sw=$('#l-switch');
    if(sw) sw.onclick=()=>{ mode = mode==='parent'?'kid':'parent'; draw(); };
  };
  draw();
}

/* ============ main app ============ */
// Change month by delta (-1 prev, +1 next), then refresh + redraw. Shared by the
// nav arrows and the swipe gesture so they behave identically. `dir` optionally
// animates the grid sliding out in that direction first.
let monthBusy = false;
async function goMonth(delta, dir){
  if(monthBusy) return;
  monthBusy = true;
  const inner = $('#gridinner');
  if(dir && inner){
    // brief slide-out in the swipe direction for tactile feedback
    inner.style.transition = 'transform .13s ease-in, opacity .13s ease-in';
    inner.style.transform = `translateX(${dir<0?'-':''}22%)`;
    inner.style.opacity = '0';
    await new Promise(r=>setTimeout(r,120));
  }
  view.setMonth(view.getMonth()+delta);
  try{ await refresh(); }catch(e){}
  renderApp();
  monthBusy = false;
}

function renderApp(preserve){
  const isKid = D.role === 'kid';
  const wasOpen = preserve && document.querySelector('.sheet.open')?.id;
  const activeTheme = document.documentElement.dataset.theme || seasonalTheme();
  document.documentElement.style.setProperty('--p1', D.parents[0]?.color || '#2F6D62');
  document.documentElement.style.setProperty('--p2', D.parents[1]?.color || '#C0702A');
  const inboxCount = isKid ? 0 : myInbox().length;
  const whoName = isKid ? (me?.name || 'Kid') : parent(D.me).name;

  $('#app').innerHTML = `
  <header class="app">
    <div class="brand display"><span class="season-mark" aria-hidden="true">${CALENDAR_THEMES[activeTheme].icon}</span>Our Calendar <span class="who">signed in as ${esc(whoName)}${isKid?' · view only':''}</span></div>
    <div class="monthnav">
      <button class="iconbtn" id="prev" aria-label="Previous month">‹</button>
      <div class="month display">${MONTHS[view.getMonth()]} ${view.getFullYear()}</div>
      <button class="iconbtn" id="next" aria-label="Next month">›</button>
      <button class="btn small" id="today">Today</button>
    </div>
    ${isKid?'':`<button class="iconbtn" id="inbox" aria-label="Approvals">⏳${inboxCount?`<span class="badge">${inboxCount}</span>`:''}</button>`}
    ${isKid?'':`<button class="iconbtn" id="expenses" aria-label="Expenses">💰${expenseBadge()?`<span class="badge">${expenseBadge()}</span>`:''}</button>`}
    ${isKid?'':`<button class="iconbtn" id="settings" aria-label="Settings">⚙</button>`}
    <button class="btn small" id="signout">Sign out</button>
  </header>
  <div class="legend">
    ${D.parents.map(p=>`<span><i style="background:${p.color}"></i>${esc(p.name)}'s week</span>`).join('')}
    <span>⏳ waiting on approval</span>
    <span><i style="background:#9AA093"></i>unassigned</span>
    <span><i style="background:#fff;border:2px dashed var(--ink)"></i>swapped day</span>
    <span>🎂 birthday</span>
    <span>📟 on call</span>
  </div>
  <div class="cal-wrap">
    <div class="dow">${DOWS.map(d=>`<div>${d}</div>`).join('')}</div>
    <div class="grid-view" id="gridview"><div class="grid-inner" id="gridinner"><div class="grid" id="grid"></div></div></div>
  </div>
  <div class="overlay" id="overlay"></div>
  <div class="sheet" id="daysheet"></div>
  <div class="sheet" id="inboxsheet"></div>
  <div class="sheet" id="expsheet"></div>
  <div class="sheet" id="setsheet"></div>`;

  renderGrid();
  $('#prev').onclick=()=>goMonth(-1);
  $('#next').onclick=()=>goMonth(1);
  $('#today').onclick=()=>{ view=new Date(); view.setDate(1); refresh().then(()=>renderApp()); };
  if($('#inbox')) $('#inbox').onclick=()=>openInbox();
  if($('#expenses')) $('#expenses').onclick=()=>openExpenses();
  if($('#settings')) $('#settings').onclick=()=>openSettings();
  $('#signout').onclick=async()=>{ try{await api('/api/logout',{method:'POST'});}catch(e){} signOutLocal(); };
  $('#overlay').onclick=closeSheets;

  if (wasOpen==='daysheet' && openDate) openDay(openDate);
  else if (wasOpen==='inboxsheet') openInbox();

  setupGridZoom();
}

/* ============ pinch-to-zoom on the calendar grid (touch only) ============
   Scales ONLY the grid — header, legend and sheets stay put. At 1x the grid
   fits the screen (fit-to-screen CSS); pinching past 1x lets you zoom in on a
   busy week and pan around it. Double-tap resets to fit. */
let gridZoom = { scale:1, x:0, y:0 };
function setupGridZoom(){
  const view = $('#gridview'), inner = $('#gridinner');
  if(!view || !inner) return;
  // Touch devices only — leave desktop mouse behaviour completely alone.
  if(!('ontouchstart' in window) && !(navigator.maxTouchPoints>0)) return;

  // Fresh render — start at fit-to-screen.
  gridZoom = { scale:1, x:0, y:0 };
  applyGridZoom(inner);

  let startDist=0, startScale=1, startMid=null, startXY=null;
  let panStart=null;                 // one-finger pan when already zoomed
  let lastTap=0;
  let swipe=null;                    // one-finger horizontal swipe when NOT zoomed

  const dist=(t)=>Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);
  const mid=(t)=>({ x:(t[0].clientX+t[1].clientX)/2, y:(t[0].clientY+t[1].clientY)/2 });
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));

  view.addEventListener('touchstart', e=>{
    if(e.touches.length===2){
      // Begin a pinch. Remember the starting spread, scale, and the screen point
      // under the fingers so we can zoom toward it.
      startDist=dist(e.touches); startScale=gridZoom.scale;
      const r=view.getBoundingClientRect(); const m=mid(e.touches);
      startMid={ x:m.x-r.left, y:m.y-r.top };
      startXY={ x:gridZoom.x, y:gridZoom.y };
      view.classList.add('zooming');
      e.preventDefault();
    } else if(e.touches.length===1 && gridZoom.scale>1.01){
      // Pan the zoomed grid with one finger.
      panStart={ x:e.touches[0].clientX-gridZoom.x, y:e.touches[0].clientY-gridZoom.y };
    } else if(e.touches.length===1){
      // Not zoomed: a one-finger drag might be a month swipe. Record the origin;
      // we only commit to it in touchmove once it's clearly horizontal.
      swipe={ x0:e.touches[0].clientX, y0:e.touches[0].clientY, dx:0, dy:0, horizontal:false };
    }
  }, { passive:false });

  view.addEventListener('touchmove', e=>{
    if(e.touches.length===2 && startDist){
      const next=clamp(startScale * dist(e.touches)/startDist, 1, 3);
      // Keep the pinch midpoint anchored: solve for translate so the same grid
      // point stays under the fingers as scale changes.
      const k = next/startScale;
      gridZoom.scale = next;
      gridZoom.x = startMid.x - (startMid.x - startXY.x)*k;
      gridZoom.y = startMid.y - (startMid.y - startXY.y)*k;
      constrainPan(view, inner);
      applyGridZoom(inner);
      e.preventDefault();
    } else if(e.touches.length===1 && panStart){
      gridZoom.x = e.touches[0].clientX - panStart.x;
      gridZoom.y = e.touches[0].clientY - panStart.y;
      constrainPan(view, inner);
      applyGridZoom(inner);
      e.preventDefault();
    } else if(e.touches.length===1 && swipe){
      swipe.dx = e.touches[0].clientX - swipe.x0;
      swipe.dy = e.touches[0].clientY - swipe.y0;
      // Lock to horizontal once the finger has clearly moved sideways more than
      // down. If it's a vertical drag, let the page scroll and drop the swipe.
      if(!swipe.horizontal){
        if(Math.abs(swipe.dx) > 12 && Math.abs(swipe.dx) > Math.abs(swipe.dy)*1.4){
          swipe.horizontal = true;
        } else if(Math.abs(swipe.dy) > 12){
          swipe = null; return;      // it's a vertical scroll, not a swipe
        }
      }
      if(swipe.horizontal){
        // Follow the finger a little so the swipe feels responsive.
        const follow = Math.max(-60, Math.min(60, swipe.dx*0.4));
        inner.style.transition = 'none';
        inner.style.transform = `translateX(${follow}px)`;
        e.preventDefault();
      }
    }
  }, { passive:false });

  view.addEventListener('touchend', e=>{
    if(e.touches.length<2){ startDist=0; view.classList.remove('zooming'); }
    if(e.touches.length===0){
      panStart=null;
      // Resolve a horizontal swipe (only meaningful when not zoomed).
      if(swipe && swipe.horizontal && gridZoom.scale<=1.01){
        const THRESH = Math.min(90, view.clientWidth*0.22);   // ~1/5 screen
        if(swipe.dx <= -THRESH){ swipe=null; goMonth(1, 1); return; }   // swipe left → next
        if(swipe.dx >=  THRESH){ swipe=null; goMonth(-1, -1); return; } // swipe right → prev
        // Didn't reach the threshold — snap the grid back to center.
        inner.style.transition = 'transform .16s ease-out';
        inner.style.transform = 'translateX(0)';
      }
      swipe=null;
      // Double-tap to reset to fit.
      const nowT=Date.now();
      if(nowT-lastTap<300 && gridZoom.scale>1.01){
        gridZoom={ scale:1, x:0, y:0 }; applyGridZoom(inner);
      }
      lastTap=nowT;
      // Snap back to exactly 1x if within a hair (avoids a stuck 1.02x).
      if(gridZoom.scale<1.02 && gridZoom.scale!==1){ gridZoom={scale:1,x:0,y:0}; applyGridZoom(inner); }
    }
  });
}
function applyGridZoom(inner){
  inner.style.transform = `translate(${gridZoom.x}px,${gridZoom.y}px) scale(${gridZoom.scale})`;
  // While zoomed in, mark the view so CSS can allow panning / block page scroll.
  const view=inner.parentElement;
  if(view) view.classList.toggle('zoomed', gridZoom.scale>1.01);
}
// Stop the grid being panned off into empty space.
function constrainPan(view, inner){
  if(gridZoom.scale<=1){ gridZoom.x=0; gridZoom.y=0; return; }
  const vw=view.clientWidth, vh=view.clientHeight;
  const cw=vw*gridZoom.scale, ch=vh*gridZoom.scale;
  gridZoom.x = Math.min(0, Math.max(vw-cw, gridZoom.x));
  gridZoom.y = Math.min(0, Math.max(vh-ch, gridZoom.y));
}

function renderGrid(){
  const y=view.getFullYear(), m=view.getMonth();
  const first=new Date(y,m,1).getDay(), days=new Date(y,m+1,0).getDate();
  const tstr=todayStr();
  let html='';
  for(let i=0;i<first;i++) html+=`<div class="day blank"></div>`;
  for(let d=1;d<=days;d++){
    const ds=`${y}-${pad(m+1)}-${pad(d)}`;
    const dow=new Date(y,m,d).getDay();
    const c=custodyFor(ds), cp=c.pid?parent(c.pid):null;
    const all=itemsOn(ds);
    // Multi-day EVENTS render as a solid connecting bar; ON-CALL periods as a distinct
    // outlined bar (awareness, not a hard commitment); everything else as normal chips.
    const spans=all.filter(a=>a.type==='event'&&a.end_date);
    const oncalls=all.filter(a=>a.type==='oncall');
    const appts=all.filter(a=>!(a.type==='event'&&a.end_date)&&a.type!=='oncall');
    const shown=appts.slice(0,2);
    const spanBars=spans.map(a=>{
      const isStart=a.date===ds, isEnd=a.end_date===ds, weekStart=dow===0;
      const bg=a.parent_id?parent(a.parent_id).color:'#9AA093';
      const unsettled=!a.confirmed||!!pendingFor(a.id);
      // Show the label on the event's first day, or the first cell of each week row.
      const label=(isStart||weekStart)?`${unsettled?'⏳ ':''}${esc(a.title)}`:'&nbsp;';
      return `<span class="spanbar ${isStart?'s-start':''} ${isEnd?'s-end':''} ${unsettled?'pending':''}"
        style="background:${bg}">${label}</span>`;
    }).join('');
    const oncallBars=oncalls.map(a=>{
      const start=a.date, end=a.end_date||a.date;
      const isStart=start===ds, isEnd=end===ds, weekStart=dow===0;
      const col=a.parent_id?parent(a.parent_id).color:'#9AA093';
      const nm=a.parent_id?parent(a.parent_id).name:'';
      const label=(isStart||weekStart)?`📟 ${esc(nm)} on call`:'&nbsp;';
      return `<span class="oncallbar ${isStart?'s-start':''} ${isEnd?'s-end':''}"
        style="color:${col};border-color:${col}">${label}</span>`;
    }).join('');
    html+=`
    <button class="day ${ds===tstr?'today':''} ${c.pendingSwap?'pendingswap':''}" data-d="${ds}" style="${cp?`background:${tint(cp.color,.10)};`:''}">
      <span class="num">${d}</span>
      ${cp?`<span class="who ${c.override?'override':''}" style="background:${cp.color}">${esc(cp.name[0])}</span>`:''}
      ${c.pendingSwap?`<span class="swaptag">swap?</span>`:''}
      ${oncallBars}
      ${spanBars}
      ${shown.map(a=>{
        if(a.type==='birthday')
          return `<span class="chip bday">🎂 ${esc(a.title)}</span>`;
        const bg=a.parent_id?parent(a.parent_id).color:'#9AA093';
        const unsettled=!a.confirmed||!!pendingFor(a.id);
        return `<span class="chip ${unsettled?'pending':''}" style="background:${bg}">
          ${unsettled?'⏳ ':''}${a.time?`<span class="t">${fmtTime(a.time)}</span>`:''}${esc(a.title)}</span>`;
      }).join('')}
      ${appts.length>2?`<span class="more">+${appts.length-2} more</span>`:''}
    </button>`;
  }
  $('#grid').innerHTML=html;
  document.querySelectorAll('.day[data-d]').forEach(b=>b.onclick=()=>openDay(b.dataset.d));
}

/* ============ sheets ============ */
function closeSheets(){
  document.querySelectorAll('.sheet').forEach(s=>s.classList.remove('open'));
  $('#overlay').classList.remove('open'); openDate=null; editingId=null;
}
function showSheet(id){ closeSheets(); $('#overlay').classList.add('open'); $(id).classList.add('open'); if(id==='#daysheet'){} }

/* ---- day sheet ---- */
function openDay(ds){
  openDate=ds;
  const c=custodyFor(ds), cp=c.pid?parent(c.pid):null;
  const appts=itemsOn(ds);
  const sheet=$('#daysheet');

  // Kids get a read-only day: whose day it is + what's scheduled. No swap, no add, no edit.
  if(D.role==='kid'){
    sheet.innerHTML=`
    <header><h2 class="display">${fmtDate(ds)}</h2><button class="x" aria-label="Close">✕</button></header>
    <div class="body">
      <div class="custody-row">
        ${cp?`<span class="custody-tag" style="background:${cp.color}">${esc(cp.name)}'s day${c.override?' (swapped)':''}</span>`
            :`<span class="empty">No custody day set.</span>`}
      </div>
      <div class="section-h">On this day</div>
      ${appts.length?appts.map(a=>apptCard(a,ds)).join(''):`<div class="empty">Nothing scheduled.</div>`}
    </div>`;
    showSheet('#daysheet');
    sheet.querySelector('.x').onclick=closeSheets;
    return;
  }

  const o=other();
  const ps=c.pendingSwap;
  const swapTarget = c.pid===D.parents[0].id?D.parents[1].id:D.parents[0].id;

  let swapUI='';
  if(ps){
    const mineToAnswer = ps.to_parent===D.me;
    swapUI = `<div class="pendbox">
      <div class="pendhead">⏳ ${mineToAnswer?`${esc(parent(ps.from_parent).name)} wants to swap this day`:`Waiting on ${esc(parent(ps.to_parent).name)}`}</div>
      <div class="pendbody">Would become <b>${ps.to_parent_on_date?esc(parent(ps.to_parent_on_date).name)+"'s day":'the normal rotation'}</b>. Nothing changes until it's accepted.</div>
      ${ps.message?`<div class="pendmsg">"${esc(ps.message)}"</div>`:''}
      <div class="actions">${mineToAnswer
        ? `<button class="btn small primary" data-p="${ps.id}" data-pa="accept">Accept swap</button>
           <button class="btn small" data-p="${ps.id}" data-pa="decline">Decline</button>`
        : `<button class="btn small" data-p="${ps.id}" data-pa="cancel">Withdraw</button>`}</div>
    </div>`;
  }

  sheet.innerHTML=`
  <header><h2 class="display">${fmtDate(ds)}</h2><button class="x" aria-label="Close">✕</button></header>
  <div class="body">
    <div class="custody-row">
      ${cp?`<span class="custody-tag" style="background:${cp.color}">${esc(cp.name)}'s day${c.override?' (swapped)':''}</span>`
          :`<span class="empty">No custody schedule set yet — set it in ⚙ settings</span>`}
      ${cp&&!ps?`<button class="btn small" id="d-swap">Ask to swap to ${esc(parent(swapTarget).name)}</button>`:''}
      ${c.override&&!ps?`<button class="btn small" id="d-reset">Ask to undo swap</button>`:''}
    </div>
    ${swapUI}

    <div class="section-h">On this day</div>
    ${appts.length?appts.map(a=>apptCard(a,ds)).join(''):`<div class="empty">Nothing scheduled.</div>`}

    <div class="section-h">${editingId?'Edit':'Add something'}</div>
    <div class="field"><label>What is it</label>
      <select id="a-type">
        <option value="appointment">Appointment</option>
        <option value="event">Event</option>
        <option value="oncall">On-call period</option>
        <option value="birthday">Birthday (repeats every year)</option>
      </select>
    </div>
    <div class="field"><label>Title</label><input id="a-title" placeholder="e.g. Dentist"></div>
    <div class="field"><label>Kid</label>
      <select id="a-kid"><option value="">—</option>${D.kids.map(k=>`<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select>
    </div>
    <div class="field" id="f-bdate" style="display:none"><label>Birth date (year included, so we can show their age)</label>
      <input id="a-bdate" type="date"></div>
    <div class="field" id="f-time"><label>Time</label><input id="a-time" type="time"></div>
    <div class="field" id="f-enddate" style="display:none"><label>End date <span class="empty">(leave blank for a single day)</span></label>
      <input id="a-enddate" type="date"></div>
    <div class="field" id="f-parent"><label>Who's taking them</label>
      <select id="a-parent">
        <option value="">Nobody yet / both</option>
        ${D.parents.map(p=>`<option value="${p.id}">${esc(p.name)}${p.id===D.me?' (me)':''}</option>`).join('')}
      </select>
    </div>
    <div class="field" id="f-msg" style="display:none"><label>Note to ${esc(o.name)} (optional)</label>
      <input id="a-msg" placeholder="e.g. I'm stuck at work that afternoon"></div>
    <div class="hint" id="a-hint"></div>
    <div class="field"><label>Notes</label><textarea id="a-notes" rows="2" placeholder="Address, what to bring…"></textarea></div>
    <div style="display:flex; gap:8px">
      <button class="btn primary" id="a-save">${editingId?'Save changes':'Add it'}</button>
      ${editingId?`<button class="btn" id="a-cancel">Cancel edit</button>`:''}
    </div>
    <div class="err" id="a-err"></div>
  </div>`;
  showSheet('#daysheet');
  sheet.querySelector('.x').onclick=closeSheets;
  $('#a-parent').value = c.pid || D.me;
  $('#a-bdate').value = ds;

  const syncType=()=>{
    const t=$('#a-type').value;
    const isOncall=t==='oncall';
    $('#f-time').style.display   = (t==='birthday'||isOncall)?'none':'';
    $('#f-parent').style.display = t==='birthday'?'none':'';
    $('#f-bdate').style.display  = t==='birthday'?'':'none';
    $('#f-enddate').style.display = (t==='event'||isOncall)?'':'none';   // multi-day: events + on-call
    // On-call is about the parent, not a kid — hide the kid picker for it.
    const kidField=$('#a-kid').closest('.field'); if(kidField) kidField.style.display=isOncall?'none':'';
    // The "who" picker means different things per type.
    const parentLabel=$('#f-parent').querySelector('label');
    if(parentLabel) parentLabel.textContent = isOncall ? "Who's on call" : "Who's taking them";
    $('#a-title').placeholder = t==='birthday'?"e.g. Ava's birthday":isOncall?'e.g. Work on-call':t==='event'?'e.g. Out of town':'e.g. Dentist';
    if(t!=='event'&&!isOncall) $('#a-enddate').value='';
    // On-call always defaults to yourself; you can't put the other parent on call.
    if(isOncall){ $('#a-parent').value=D.me; }
    syncOwner();
  };
  // Assigning the other parent turns this into a request that needs their OK.
  // On-call is awareness-only, so it never needs approval even if it's the other parent's.
  const syncOwner=()=>{
    const t=$('#a-type').value;
    const needsOk = t!=='birthday' && t!=='oncall' && +$('#a-parent').value===o.id;
    $('#f-msg').style.display = needsOk?'':'none';
    $('#a-hint').textContent = t==='oncall'
      ? `Just so ${o.name} knows you might get pulled away. No approval needed — it's informational.`
      : needsOk
      ? `${o.name} has to accept this before it's on her. It'll show as pending until she does.`
      : '';
    $('#a-save').textContent = needsOk ? (editingId?`Send change to ${o.name}`:`Ask ${o.name} to take it`)
                                       : (editingId?'Save changes':'Add it');
  };
  $('#a-type').onchange=syncType;
  $('#a-parent').onchange=syncOwner;
  syncType();

  if (editingId){
    const a=D.appointments.find(x=>x.id===editingId);
    if(a){ $('#a-type').value=a.type||'appointment';
           $('#a-title').value=a.title; $('#a-kid').value=a.kid_id||''; $('#a-time').value=a.time||'';
           $('#a-parent').value=a.parent_id||''; $('#a-notes').value=a.notes||''; $('#a-bdate').value=a.date;
           $('#a-enddate').value=a.end_date||'';
           syncType(); }
    $('#a-cancel').onclick=()=>{ editingId=null; openDay(ds); };
  }

  if($('#d-swap')) $('#d-swap').onclick=async()=>{
    const msg=await ask({ title:`Ask ${o.name} to swap this day?`,
      body:`It would become ${parent(swapTarget).name}'s day. Nothing changes until she accepts.`,
      placeholder:'Add a note (optional)', ok:'Send request' });
    if(msg===null) return;
    try{
      await api('/api/swap',{method:'POST',body:{date:ds,parent_id:swapTarget,message:msg.trim()||null}});
      await refresh(); renderApp(); openDay(ds); toast(`Swap sent to ${o.name}`);
    }catch(e){ toast(e.error||'Could not send'); }
  };
  if($('#d-reset')) $('#d-reset').onclick=async()=>{
    const msg=await ask({ title:'Ask to undo this swap?',
      body:`The day would go back to the normal rotation. ${o.name} has to accept.`,
      placeholder:'Add a note (optional)', ok:'Send request' });
    if(msg===null) return;
    try{
      await api('/api/swap',{method:'POST',body:{date:ds,parent_id:null,message:msg.trim()||null}});
      await refresh(); renderApp(); openDay(ds); toast(`Sent to ${o.name}`);
    }catch(e){ toast(e.error||'Could not send'); }
  };

  $('#a-save').onclick=async()=>{
    const t=$('#a-type').value;
    const spanType = (t==='event'||t==='oncall');
    // For an edited span (event/on-call), its real start is the stored date (ds may be a middle day).
    const editItem = editingId ? D.appointments.find(x=>x.id===editingId) : null;
    const startDate = t==='birthday' ? $('#a-bdate').value
                    : (editItem && spanType ? editItem.date : ds);
    const endVal = (spanType && $('#a-enddate').value) ? $('#a-enddate').value : null;
    const body={ type:t, title:$('#a-title').value.trim(), kid_id:t==='oncall'?null:(+$('#a-kid').value||null),
                 date: startDate,
                 end_date: endVal,
                 time:$('#a-time').value||null, notes:$('#a-notes').value.trim()||null,
                 parent_id:+$('#a-parent').value||null,
                 message:$('#a-msg').value.trim()||null };
    if(!body.title){ $('#a-err').textContent='Give it a title.'; return; }
    if(t==='birthday'&&!body.date){ $('#a-err').textContent='Pick the birth date.'; return; }
    if(endVal && endVal<startDate){ $('#a-err').textContent='The end date is before the start date.'; return; }
    try{
      let r;
      if(editingId) r = await api('/api/appointments/'+editingId,{method:'PUT',body});
      else r = await api('/api/appointments',{method:'POST',body});
      editingId=null; await refresh(); renderApp(); openDay(ds);
      toast(r.pending?`Sent to ${o.name} — waiting on her OK`:'Saved');
    }catch(e){ $('#a-err').textContent=e.error||'Could not save'; }
  };

  // Proposal buttons inside the swap box.
  sheet.querySelectorAll('[data-p]').forEach(b=>{
    b.onclick=async()=>{
      try{ await respondProposal(b.dataset.p, b.dataset.pa);
           await refresh(); renderApp(); openDay(ds);
      }catch(e){ toast(e.error||'Something went wrong'); }
    };
  });
  sheet.querySelectorAll('[data-act]').forEach(b=>{
    const id=+b.dataset.id, act=b.dataset.act;
    b.onclick=async()=>{
      try{
        if(act==='edit'){ editingId=id; openDay(ds); return; }
        if(act==='del'){
          const yes=await ask({ title:'Delete this?', body:'It disappears for both of you.',
            input:false, ok:'Delete', danger:true });
          if(!yes) return;
          await api('/api/appointments/'+id,{method:'DELETE'}); toast('Deleted');
        }
        if(act==='handoff'){
          const msg=await ask({ title:`Ask ${o.name} to take this?`,
            body:"It's not hers until she accepts.",
            placeholder:'Add a note (optional)', ok:'Send request' });
          if(msg===null) return;
          await api('/api/appointments/'+id+'/handoff',{method:'POST',body:{message:msg.trim()||null}});
          toast(`Sent to ${o.name} — waiting on her OK`);
        }
        if(act==='claim'){
          await api('/api/appointments/'+id,{method:'PUT',body:{parent_id:D.me}});
          toast("You've got it");
        }
        await refresh(); renderApp(); openDay(ds);
      }catch(e){ toast(e.error||'Something went wrong'); }
    };
  });
}

// Accept / decline / withdraw a proposal.
async function respondProposal(id, action){
  if(action==='cancel'){ await api('/api/proposals/'+id+'/cancel',{method:'POST'}); toast('Withdrawn'); return; }
  await api('/api/proposals/'+id+'/respond',{method:'POST',body:{accept:action==='accept'}});
  toast(action==='accept'?'Accepted':'Declined');
}

function apptCard(a, ds){
  const kid=D.kids.find(k=>k.id===a.kid_id);
  const readOnly = D.role==='kid';
  const baseActions = readOnly ? '' : `<button class="btn small" data-act="edit" data-id="${a.id}">Edit</button>
                     <button class="btn small danger" data-act="del" data-id="${a.id}">Delete</button>`;

  if(a.type==='birthday'){
    const age=bdayAge(a, ds||a.date);
    return `<div class="appt">
      <div class="top"><b>&#127874; ${esc(a.title)}</b>${age?`<span>turning ${age}</span>`:''}</div>
      <div class="meta">${kid?esc(kid.name)+' &middot; ':''}repeats every year${a.notes?' &middot; '+esc(a.notes):''}</div>
      <div class="actions">${baseActions}</div>
    </div>`;
  }

  if(a.type==='oncall'){
    const oc=a.parent_id?parent(a.parent_id):null;
    const range=a.end_date?`${fmtDate(a.date)} &rarr; ${fmtDate(a.end_date)}`:fmtDate(a.date);
    // Only the parent whose on-call it is can edit/remove it.
    const mineToEdit = !readOnly && a.parent_id===D.me;
    const ocActions = mineToEdit
      ? `<button class="btn small" data-act="edit" data-id="${a.id}">Edit</button>
         <button class="btn small danger" data-act="del" data-id="${a.id}">Remove</button>` : '';
    return `<div class="appt oncall">
      <div class="top"><b>&#128223; ${esc(a.title)}</b></div>
      <div class="meta">${range}${a.notes?' &middot; '+esc(a.notes):''}</div>
      <span class="own oncall-own" style="border-color:${oc?oc.color:'#9AA093'}; color:${oc?oc.color:'#6B7265'}">${oc?esc(oc.name)+' on call':'On call'}</span>
      ${ocActions?`<div class="actions">${ocActions}</div>`:''}
    </div>`;
  }

  const owner=a.parent_id?parent(a.parent_id):null;
  const p=pendingFor(a.id);
  const o=other();
  const settled = a.confirmed && !p;

  // Ownership line
  let ownLine;
  if(!owner) ownLine=`<span class="own" style="background:#9AA093">Nobody yet &mdash; unassigned</span>`;
  else if(settled) ownLine=`<span class="own" style="background:${owner.color}">${esc(owner.name)} ${a.type==='event'?'is on it':'is taking them'}</span>`;
  else ownLine=`<span class="own unsettled" style="border-color:${owner.color}; color:${owner.color}">&#9203; ${esc(owner.name)} &mdash; not agreed yet</span>`;

  // Pending banner + action buttons
  let banner='', actions=baseActions;
  if(readOnly){
    // Kids: show the ownership state, but no action buttons at all.
    const range=a.end_date?`${fmtDate(a.date)} &rarr; ${fmtDate(a.end_date)}`:'';
    return `<div class="appt ${p?'ispending':''}">
      <div class="top"><b>${esc(a.title)}</b>${a.time?`<span>${fmtTime(a.time)}</span>`:''}</div>
      <div class="meta">${a.type==='event'?'Event &middot; ':''}${range?range+' &middot; ':''}${kid?esc(kid.name)+' &middot; ':''}${a.notes?esc(a.notes):''}</div>
      ${ownLine}
    </div>`;
  }
  if(p){
    const mineToAnswer = p.to_parent===D.me;
    const from = parent(p.from_parent).name;
    const label = p.kind==='edit' ? `${esc(from)} changed something you agreed to`
                : p.kind==='assign' ? `${esc(from)} is asking you to take this`
                : `${esc(from)} is asking you to take this over`;
    banner=`<div class="pendbox tight">
      <div class="pendhead">&#9203; ${mineToAnswer?label:`Waiting on ${esc(parent(p.to_parent).name)} to accept`}</div>
      ${p.message?`<div class="pendmsg">"${esc(p.message)}"</div>`:''}
      ${p.kind==='edit'?`<div class="pendbody">The old version stands until it's accepted.</div>`:''}
    </div>`;
    actions = mineToAnswer
      ? `<button class="btn small primary" data-p="${p.id}" data-pa="accept">Accept</button>
         <button class="btn small" data-p="${p.id}" data-pa="decline">Decline</button>` + baseActions
      : `<button class="btn small" data-p="${p.id}" data-pa="cancel">Withdraw</button>` + baseActions;
  } else if(!owner){
    actions=`<button class="btn small primary" data-act="claim" data-id="${a.id}">I'll take it</button>
             <button class="btn small" data-act="handoff" data-id="${a.id}">Ask ${esc(o.name)}</button>`+baseActions;
  } else if(owner.id===D.me){
    actions=`<button class="btn small" data-act="handoff" data-id="${a.id}">Ask ${esc(o.name)} to take it</button>`+baseActions;
  }

  return `<div class="appt ${p?'ispending':''}">
    <div class="top"><b>${esc(a.title)}</b>${a.time?`<span>${fmtTime(a.time)}</span>`:''}</div>
    <div class="meta">${a.type==='event'?'Event &middot; ':''}${a.end_date?`${fmtDate(a.date)} &rarr; ${fmtDate(a.end_date)} &middot; `:''}${kid?esc(kid.name)+' &middot; ':''}${a.notes?esc(a.notes):''}</div>
    ${ownLine}${banner}<div class="actions">${actions}</div>
  </div>`;
}

/* ---- inbox ---- */
function openInbox(){
  const mine=(D.pending||[]).filter(p=>p.to_parent===D.me);
  const sent=(D.pending||[]).filter(p=>p.from_parent===D.me);
  const done=(D.history||[]).slice(0,10);
  const sheet=$('#inboxsheet');

  const title=p=>{
    if(p.kind==='swap_day') return `Day swap &mdash; ${fmtDate(p.date)}`;
    return esc(p.title||'Appointment');
  };
  const detail=p=>{
    if(p.kind==='swap_day')
      return `Would become <b>${p.to_parent_on_date?esc(parent(p.to_parent_on_date).name)+"'s day":'the normal rotation'}</b>`;
    const kid=D.kids.find(k=>k.id===p.kid_id);
    const w=`${fmtDate(p.item_date)}${p.item_time?' &middot; '+fmtTime(p.item_time):''}${kid?' &middot; '+esc(kid.name):''}`;
    if(p.kind==='edit') return `${w}<br><span class="tag">changed &mdash; needs re-approval</span>`;
    if(p.kind==='reassign') return `${w}<br><span class="tag">handoff</span>`;
    return w;
  };
  const card=(p,box)=>`
    <div class="req ${box==='in'?'needsme':''}">
      <div class="head">${title(p)}</div>
      <div class="meta">${detail(p)}</div>
      ${p.message?`<div class="msg">"${esc(p.message)}"</div>`:''}
      ${box==='in'?`<div class="actions">
          <button class="btn small primary" data-p="${p.id}" data-pa="accept">Accept</button>
          <button class="btn small" data-p="${p.id}" data-pa="decline">Decline</button></div>`
      :box==='out'?`<div class="actions"><span class="meta" style="margin:0">Waiting on ${esc(parent(p.to_parent).name)}</span>
          <button class="btn small" data-p="${p.id}" data-pa="cancel">Withdraw</button></div>`
      :`<div class="status" style="color:${p.status==='accepted'?'#2F6D62':'var(--muted)'}">${esc(p.status)}${p.status==='declined'&&p.kind!=='swap_day'?' &mdash; unassigned until someone claims it':''}</div>`}
    </div>`;

  sheet.innerHTML=`
  <header><h2 class="display">Approvals</h2><button class="x" aria-label="Close">&#10005;</button></header>
  <div class="body">
    <div class="section-h">Needs your answer</div>
    ${mine.length?mine.map(p=>card(p,'in')).join(''):'<div class="empty">Nothing waiting on you.</div>'}
    <div class="section-h">Waiting on ${esc(other().name)}</div>
    ${sent.length?sent.map(p=>card(p,'out')).join(''):'<div class="empty">Nothing outstanding.</div>'}
    <div class="section-h">Recent</div>
    ${done.length?done.map(p=>card(p,'hist')).join(''):'<div class="empty">No history yet.</div>'}
  </div>`;
  showSheet('#inboxsheet');
  sheet.querySelector('.x').onclick=closeSheets;
  sheet.querySelectorAll('[data-p]').forEach(b=>{
    b.onclick=async()=>{
      try{ await respondProposal(b.dataset.p, b.dataset.pa);
           await refresh(); renderApp(); openInbox();
      }catch(e){ toast(e.error||'Something went wrong'); }
    };
  });
}

/* ============ expenses (shared-cost splitting) ============ */
let EXP = null;              // last /api/expenses payload
let expFormType = 'necessity';

const cents = v => Math.round(parseFloat(v) * 100);
const money = c => `$${(Math.abs(c)/100).toFixed(2)}`;
const EXP_CATS = [['medical','Medical'],['school','School'],['clothing','Clothing'],['activities','Activities'],['other','Other']];
const catLabel = c => (EXP_CATS.find(x=>x[0]===c)||[,'Other'])[1];

// Count of expenses waiting on ME: requests to accept + necessities I could dispute
// aren't a to-do, so only pending requests addressed to me + disputes I must resolve.
function expenseBadge(){
  if(!EXP) return 0;
  const mine = EXP.expenses.filter(e =>
    (e.type==='request' && e.status==='pending' && e.owed_by===EXP.me) ||
    (e.status==='disputed' && e.created_by===EXP.me)
  );
  return mine.length;
}

async function loadExpenses(){ EXP = await api('/api/expenses'); }

// A two-field modal for recording a payment: amount (prefilled to the full balance)
// plus an optional note. Resolves { amount_cents, note } or null if cancelled.
function askPayment({ title, body, max }){
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    const maxStr = (max/100).toFixed(2);
    wrap.innerHTML = `
      <div class="modal">
        <h3>${esc(title)}</h3>
        ${body ? `<p>${esc(body)}</p>` : ''}
        <div class="field"><label>Amount paid</label>
          <input class="pay-amt" type="number" inputmode="decimal" step="0.01" min="0" max="${maxStr}" value="${maxStr}"></div>
        <div class="pay-quick">
          <button type="button" class="btn small" data-full>Full ${money(max)}</button>
          <button type="button" class="btn small" data-half>Half</button>
        </div>
        <div class="field"><label>Note (optional)</label>
          <input class="pay-note" placeholder="e.g. Venmo, cash"></div>
        <div class="modal-btns">
          <button class="btn" data-x="0">Cancel</button>
          <button class="btn primary" data-x="1">Record payment</button>
        </div>
        <div class="err pay-err"></div>
      </div>`;
    document.body.appendChild(wrap);
    const amtEl = wrap.querySelector('.pay-amt');
    const noteEl = wrap.querySelector('.pay-note');
    const errEl = wrap.querySelector('.pay-err');
    requestAnimationFrame(() => { wrap.classList.add('open'); amtEl.focus(); amtEl.select(); });

    wrap.querySelector('[data-full]').onclick = ()=>{ amtEl.value = maxStr; };
    wrap.querySelector('[data-half]').onclick = ()=>{ amtEl.value = (Math.round(max/2)/100).toFixed(2); };

    const done = val => { wrap.classList.remove('open'); setTimeout(()=>wrap.remove(),150); resolve(val); };
    wrap.querySelectorAll('[data-x]').forEach(b => {
      b.onclick = () => {
        if(b.dataset.x !== '1') return done(null);
        const amt = parseFloat(amtEl.value);
        if(!amt || amt <= 0){ errEl.textContent = 'Enter an amount greater than zero.'; return; }
        if(Math.round(amt*100) > max){ errEl.textContent = `That's more than the ${maxStr} owed.`; return; }
        done({ amount_cents: Math.round(amt*100), note: noteEl.value.trim() });
      };
    });
    wrap.onclick = e => { if(e.target === wrap) done(null); };
  });
}

// A recorded payment row (from the settlements ledger).
function paymentCard(p){
  const me = EXP.me;
  const fromMe = p.from_parent === me;
  const fromName = fromMe ? 'You' : esc(parent(p.from_parent).name);
  const toName = p.to_parent === me ? 'you' : esc(parent(p.to_parent).name);
  return `<div class="exp pay">
    <div class="exp-top"><b>${fromName} paid ${toName} ${money(p.amount_cents)}</b></div>
    <div class="exp-meta">${p.created_at?fmtDate(p.created_at.slice(0,10)):''}${p.note?' · '+esc(p.note):''}</div>
  </div>`;
}

async function openExpenses(){
  try{ await loadExpenses(); }
  catch(e){ toast(e.error||'Could not load expenses'); return; }
  drawExpenses();
  // Refresh the header badge now that we have data.
  const b=$('#expenses'); if(b){ const n=expenseBadge();
    b.innerHTML = `💰${n?`<span class="badge">${n}</span>`:''}`; b.onclick=()=>openExpenses(); }
}

function drawExpenses(){
  const me = EXP.me;
  const bal = EXP.balance_cents;
  const o = other();
  const sheet = $('#expsheet');

  // Balance banner text: positive => other owes me.
  let banner;
  if(bal===0) banner = `<div class="balhead even">All square 👍</div><div class="balsub">Nobody owes anybody right now.</div>`;
  else if(bal>0) banner = `<div class="balhead owed-you">${esc(o.name)} owes you <b>${money(bal)}</b></div><div class="balsub">Running total across everything counted.</div>`;
  else banner = `<div class="balhead you-owe">You owe ${esc(o.name)} <b>${money(bal)}</b></div><div class="balsub">Running total across everything counted.</div>`;

  // Split expenses into actionable buckets.
  const all = EXP.expenses;
  const needsMe = all.filter(e => (e.type==='request'&&e.status==='pending'&&e.owed_by===me)
                               || (e.status==='disputed'&&e.created_by===me));
  const waiting = all.filter(e => (e.type==='request'&&e.status==='pending'&&e.created_by===me)
                               || (e.status==='disputed'&&e.owed_by===me));
  const counted = all.filter(e => e.status==='owed');
  const declined = all.filter(e => e.status==='declined');
  const payments = (EXP.settlements||[]);

  // You can record a payment whenever the balance isn't zero.
  const canSettle = bal !== 0;
  const settleLabel = bal>0 ? `Record a payment from ${esc(o.name)}` : `Record a payment to ${esc(o.name)}`;

  sheet.innerHTML = `
  <header><h2 class="display">Shared expenses <span class="ver-tag">v8 · swipe</span></h2><button class="x" aria-label="Close">✕</button></header>
  <div class="body">
    <div class="balbox ${bal===0?'even':bal>0?'pos':'neg'}">${banner}
      ${canSettle?`<button class="btn small" id="e-settle" style="margin-top:12px">${settleLabel}</button>`:''}
    </div>

    <div class="section-h">Log an expense</div>
    <div class="exp-toggle">
      <button class="et ${expFormType==='necessity'?'sel':''}" data-t="necessity">Necessity <span>must split</span></button>
      <button class="et ${expFormType==='request'?'sel':''}" data-t="request">Request <span>ask to split</span></button>
    </div>
    <div class="hint" id="e-typehint"></div>
    <div class="field"><label>What was it</label><input id="e-desc" placeholder="e.g. Ava's dentist copay"></div>
    <div class="exp-row">
      <div class="field"><label>Amount</label><input id="e-amt" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00"></div>
      <div class="field"><label>${esc(o.name)}'s share</label>
        <select id="e-split">
          <option value="50">Half (50%)</option>
          <option value="0">None (0%)</option>
          <option value="25">25%</option>
          <option value="40">40%</option>
          <option value="60">60%</option>
          <option value="75">75%</option>
          <option value="100">All (100%)</option>
        </select>
      </div>
    </div>
    <div class="exp-row">
      <div class="field"><label>Category</label><select id="e-cat">${EXP_CATS.map(c=>`<option value="${c[0]}">${c[1]}</option>`).join('')}</select></div>
      <div class="field"><label>Date</label><input id="e-date" type="date" value="${todayStr()}"></div>
    </div>
    ${D.kids&&D.kids.length?`<div class="field"><label>Kid (optional)</label>
      <select id="e-kid"><option value="">—</option>${D.kids.map(k=>`<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select></div>`:''}
    <div class="split-preview" id="e-preview"></div>
    <button class="btn primary" id="e-save" style="width:100%">Log it</button>
    <div class="err" id="e-err"></div>

    ${needsMe.length?`<div class="section-h">Needs your answer</div>${needsMe.map(e=>expCard(e,'me')).join('')}`:''}
    ${waiting.length?`<div class="section-h">Waiting on ${esc(o.name)}</div>${waiting.map(e=>expCard(e,'wait')).join('')}`:''}

    <div class="section-h">Counted toward the balance</div>
    ${counted.length?counted.map(e=>expCard(e,'counted')).join(''):'<div class="empty">Nothing outstanding.</div>'}

    <div class="section-h">Payments</div>
    ${payments.length?payments.slice(0,20).map(p=>paymentCard(p)).join(''):'<div class="empty">No payments recorded yet.</div>'}

    ${declined.length?`<div class="section-h">Declined / withdrawn</div>${declined.slice(0,15).map(e=>expCard(e,'hist')).join('')}`:''}
  </div>`;

  showSheet('#expsheet');
  sheet.querySelector('.x').onclick=closeSheets;

  // Type toggle
  sheet.querySelectorAll('.et').forEach(b=>{
    b.onclick=()=>{ expFormType=b.dataset.t;
      sheet.querySelectorAll('.et').forEach(x=>x.classList.remove('sel')); b.classList.add('sel');
      syncExpForm();
    };
  });

  const syncPreview=()=>{
    const amt=parseFloat($('#e-amt').value), pct=+$('#e-split').value;
    const p=$('#e-preview');
    if(!amt||amt<=0){ p.textContent=''; return; }
    const share=Math.round(cents(amt)*pct/100);
    p.innerHTML = pct===0
      ? `${esc(o.name)} owes nothing — you're covering all of ${money(cents(amt))}.`
      : pct===100
      ? `${esc(o.name)} owes the full ${money(share)}.`
      : `Splitting ${money(cents(amt))} — ${esc(o.name)}'s share is <b>${money(share)}</b>.`;
  };
  const syncExpForm=()=>{
    $('#e-typehint').textContent = expFormType==='necessity'
      ? `A shared cost that's owed by default. ${o.name} will see it as owed and can dispute it if something's off.`
      : `You're asking ${o.name} to chip in. It won't count until ${o.name} accepts.`;
    $('#e-save').textContent = expFormType==='necessity' ? 'Log it as owed' : `Ask ${o.name} to split`;
    syncPreview();
  };
  $('#e-amt').oninput=syncPreview;
  $('#e-split').onchange=syncPreview;
  syncExpForm();

  if($('#e-settle')) $('#e-settle').onclick=async()=>{
    const payer = bal>0 ? o.name : 'You';
    const payee = bal>0 ? 'you' : o.name;
    const res = await askPayment({
      title: 'Record a payment',
      body: `${payer} ${bal>0?'pays':'pay'} ${payee}. Full amount owed is ${money(Math.abs(bal))} — enter less for a partial payment.`,
      max: Math.abs(bal)
    });
    if(res===null) return;
    try{
      const r = await api('/api/expenses/settle',{method:'POST',body:{amount_cents:res.amount_cents, note:res.note||null}});
      await openExpenses();
      toast(r.remaining_cents>0 ? `Recorded — ${money(r.remaining_cents)} still owed` : 'Recorded — all square');
    }catch(e){ toast(e.error||'Could not record'); }
  };

  $('#e-save').onclick=async()=>{
    const amt=parseFloat($('#e-amt').value);
    const body={ amount_cents:cents($('#e-amt').value), split_pct:+$('#e-split').value,
      description:$('#e-desc').value.trim(), category:$('#e-cat').value,
      kid_id:$('#e-kid')?+$('#e-kid').value||null:null, date:$('#e-date').value, type:expFormType };
    if(!body.description){ $('#e-err').textContent='Add a short description.'; return; }
    if(!amt||amt<=0){ $('#e-err').textContent='Enter an amount greater than zero.'; return; }
    if(!body.date){ $('#e-err').textContent='Pick a date.'; return; }
    try{ const r=await api('/api/expenses',{method:'POST',body});
      await openExpenses();
      toast(r.status==='pending'?`Sent to ${o.name} — waiting on her`:'Logged');
    }catch(e){ $('#e-err').textContent=e.error||'Could not save'; }
  };

  // Card action buttons
  sheet.querySelectorAll('[data-exp]').forEach(b=>{
    b.onclick=async()=>{
      const id=b.dataset.exp, act=b.dataset.act;
      try{
        if(act==='accept'||act==='decline')
          await api('/api/expenses/'+id+'/respond',{method:'POST',body:{action:act}});
        else if(act==='dispute')
          await api('/api/expenses/'+id+'/respond',{method:'POST',body:{action:'dispute'}});
        else if(act==='reassert'||act==='withdraw')
          await api('/api/expenses/'+id+'/resolve',{method:'POST',body:{action:act}});
        else if(act==='del'){
          const yes=await ask({title:'Remove this expense?',body:'It disappears for both of you.',input:false,ok:'Remove',danger:true});
          if(!yes) return;
          await api('/api/expenses/'+id,{method:'DELETE'});
        }
        await openExpenses();
        toast(act==='accept'?'Accepted':act==='decline'?'Declined':act==='dispute'?'Disputed':act==='del'?'Removed':'Done');
      }catch(e){ toast(e.error||'Something went wrong'); }
    };
  });
}

// One expense card. `box` = me | wait | counted | hist — controls which buttons show.
function expCard(e, box){
  const me = EXP.me;
  const o = other();
  const kid = D.kids.find(k=>k.id===e.kid_id);
  const mine = e.created_by===me;            // I paid
  const share = Math.round(e.amount_cents*e.split_pct/100);
  const payer = mine ? 'You' : esc(o.name);
  const ower  = mine ? esc(o.name) : 'you';

  // One-line money summary from the viewer's angle.
  let moneyLine;
  if(e.status==='declined') moneyLine = `<span class="exp-dim">Not split — nothing owed</span>`;
  else if(e.status==='settled') moneyLine = `<span class="exp-dim">Settled — ${money(share)} share</span>`;
  else if(e.split_pct===0) moneyLine = `${payer} covered all of ${money(e.amount_cents)}`;
  else moneyLine = `${payer} paid ${money(e.amount_cents)} · ${ower==='you'?'You owe':ower+' owes'} <b>${money(share)}</b>${e.split_pct!==50?` (${e.split_pct}%)`:''}`;

  const badge = e.type==='necessity'
    ? `<span class="exp-tag nec">necessity</span>`
    : `<span class="exp-tag req">request</span>`;
  const statusTag = e.status==='pending'?`<span class="exp-tag pend">pending</span>`
    : e.status==='disputed'?`<span class="exp-tag disp">disputed</span>`
    : e.status==='declined'?`<span class="exp-tag decl">declined</span>`
    : e.status==='settled'?`<span class="exp-tag settl">settled</span>`:'';

  let actions='';
  if(box==='me'){
    if(e.type==='request'&&e.status==='pending'&&e.owed_by===me)
      actions=`<button class="btn small primary" data-exp="${e.id}" data-act="accept">Accept split</button>
               <button class="btn small" data-exp="${e.id}" data-act="decline">Decline</button>`;
    else if(e.status==='disputed'&&e.created_by===me)
      actions=`<div class="exp-note">${esc(o.name)} disputed this.</div>
               <button class="btn small primary" data-exp="${e.id}" data-act="reassert">Keep it (put back)</button>
               <button class="btn small" data-exp="${e.id}" data-act="withdraw">Withdraw it</button>`;
  } else if(box==='wait'){
    if(e.status==='pending')
      actions=`<span class="exp-dim">Waiting on ${esc(o.name)} to accept</span>
               <button class="btn small danger" data-exp="${e.id}" data-act="del">Cancel</button>`;
    else if(e.status==='disputed')
      actions=`<span class="exp-dim">You disputed this — waiting on ${esc(o.name)} to resolve</span>`;
  } else if(box==='counted'){
    // A live, owed item. Payer can remove it; ower (if it's a necessity) can dispute.
    if(mine) actions=`<button class="btn small danger" data-exp="${e.id}" data-act="del">Remove</button>`;
    else if(e.type==='necessity') actions=`<button class="btn small" data-exp="${e.id}" data-act="dispute">Dispute</button>`;
  }

  return `<div class="exp ${box==='me'?'needsme':''}">
    <div class="exp-top"><b>${esc(e.description)}</b>${badge}${statusTag}</div>
    <div class="exp-meta">${catLabel(e.category)}${kid?' · '+esc(kid.name):''} · ${fmtDate(e.date)}</div>
    <div class="exp-money">${moneyLine}</div>
    ${actions?`<div class="actions">${actions}</div>`:''}
  </div>`;
}

/* ---- settings ---- */
function themePicker(){
  const selected = document.documentElement.dataset.themeChoice || 'auto';
  const currentSeason = CALENDAR_THEMES[seasonalTheme()].label;
  return `<div class="theme-grid" role="group" aria-label="Calendar theme">
    ${THEME_CHOICES.map(id=>{
      const info = id === 'auto'
        ? { label:'Automatic', icon:'✨', description:`Changes by season · ${currentSeason} now` }
        : CALENDAR_THEMES[id];
      return `<button class="theme-choice ${selected===id?'sel':''}" data-theme-option="${id}" aria-pressed="${selected===id}">
        <span class="theme-swatch" aria-hidden="true">${info.icon}</span>
        <span class="theme-copy"><b>${info.label}</b><small>${info.description}</small></span>
      </button>`;
    }).join('')}
  </div>
  <p class="empty" style="margin:4px 0 6px">Saved on this device. Automatic mode uses spring (Mar–May), summer (Jun–Aug), autumn (Sep–Nov), and winter (Dec–Feb).</p>`;
}

function openSettings(){
  const sheet=$('#setsheet');
  const mine=parent(D.me);
  sheet.innerHTML=`
  <header><h2 class="display">Calendar settings</h2><button class="x" aria-label="Close">✕</button></header>
  <div class="body">
    <div class="section-h">Seasonal theme</div>
    ${themePicker()}

    <div class="section-h">Custody — week on / week off</div>
    <div class="field"><label>Exchange day (the day the kids switch houses)</label>
      <select id="sc-dow">${DOWS.map((d,i)=>`<option value="${i}">${d}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Whose week is it right now?</label>
      <select id="sc-who">${D.parents.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
    </div>
    <button class="btn primary" id="sc-save" style="width:100%">Save schedule</button>
    <p class="empty" style="margin:8px 0 6px">Weeks alternate automatically from there, forever. One-off switches are done from the day itself (open a day → Switch).</p>
    <div class="section-h">Kids</div>
    <div id="kidlist">${D.kids.map(k=>`<div class="kidrow"><span>${esc(k.name)}${k.hasPin?' <span class="tag">view-only login on</span>':''}</span>
      <span style="display:flex;gap:6px">
        <button class="btn small" data-kidpin="${k.id}" data-has="${k.hasPin?1:0}">${k.hasPin?'Change PIN':'Set PIN'}</button>
        ${k.hasPin?`<button class="btn small" data-kidpinoff="${k.id}">Turn off</button>`:''}
        <button class="btn small danger" data-kid="${k.id}">Remove</button>
      </span></div>`).join('')||'<div class="empty">No kids added yet.</div>'}</div>
    <div class="addkid"><input id="k-name" placeholder="Kid's name"><button class="btn" id="k-add">Add</button></div>
    <p class="empty" style="margin:6px 0 0">Give a kid a PIN and they can sign in to see the calendar — but not change anything.</p>

    <div class="section-h">Email notifications</div>
    ${D.mailReady?'':`<div class="warn">Email isn't switched on yet. Add RESEND_API_KEY (and MAIL_FROM) in your Railway variables and redeploy — the settings below will start working right away.</div>`}
    <div class="field"><label>Your email</label><input id="n-email" type="email" placeholder="name@email.com" value="${esc(mine.email||'')}"></div>
    <label class="check"><input type="checkbox" id="n-on" ${mine.notify?'checked':''}> Email me when ${esc(other().name)} needs my OK or answers one of my requests</label>
    <button class="btn primary" id="n-save" style="width:100%; margin-top:10px">Save notification settings</button>
    <div class="err" id="n-err"></div>
    <p class="empty">You'll get an email when ${esc(other().name)} asks you to take an appointment, proposes a day swap, changes something you already agreed to, or answers one of your requests — plus a heads-up when she adds something that doesn't need your approval. ${other().email?`${esc(other().name)} has an email set${other().notify?' and notifications on':' but notifications off'}.`:`${esc(other().name)} hasn't added an email yet, so they won't get any.`}</p>
  </div>`;
  showSheet('#setsheet');
  sheet.querySelector('.x').onclick=closeSheets;
  sheet.querySelectorAll('[data-theme-option]').forEach(button=>{
    button.onclick=()=>{
      const choice = button.dataset.themeOption;
      const active = applyTheme(choice, true);
      sheet.querySelectorAll('[data-theme-option]').forEach(option=>{
        const selected = option.dataset.themeOption === choice;
        option.classList.toggle('sel', selected);
        option.setAttribute('aria-pressed', String(selected));
      });
      const mark = document.querySelector('.season-mark');
      if(mark) mark.textContent = CALENDAR_THEMES[active].icon;
      toast(choice === 'auto' ? `Automatic · ${CALENDAR_THEMES[active].label}` : `${CALENDAR_THEMES[active].label} theme`);
    };
  });
  // Preselect current schedule values if set
  if(D.schedule){
    $('#sc-dow').value = new Date(D.schedule.anchor_date+'T12:00:00').getDay();
    $('#sc-who').value = custodyFor(todayStr()).pid || D.schedule.anchor_parent;
  }
  $('#sc-save').onclick=async()=>{
    const dow=+$('#sc-dow').value, who=+$('#sc-who').value;
    // Anchor = most recent exchange day on or before today; that week belongs to `who`.
    const t=new Date(); t.setHours(12,0,0,0);
    const back=(t.getDay()-dow+7)%7;
    t.setDate(t.getDate()-back);
    const anchor=`${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`;
    await api('/api/schedule',{method:'POST',body:{anchor_date:anchor,anchor_parent:who}});
    await refresh(); renderApp(); openSettings(); toast('Schedule saved');
  };
  $('#k-add').onclick=async()=>{
    const name=$('#k-name').value.trim(); if(!name) return;
    await api('/api/kids',{method:'POST',body:{name}});
    await refresh(); renderApp(); openSettings();
  };
  sheet.querySelectorAll('[data-kid]').forEach(b=>{
    b.onclick=async()=>{
      const yes=await ask({ title:'Remove this kid?', body:'Their appointments stay, just untagged.',
        input:false, ok:'Remove', danger:true });
      if(!yes) return;
      await api('/api/kids/'+b.dataset.kid,{method:'DELETE'});
      await refresh(); renderApp(); openSettings();
    };
  });
  sheet.querySelectorAll('[data-kidpin]').forEach(b=>{
    b.onclick=async()=>{
      const has=b.dataset.has==='1';
      const pin=await ask({ title: has?'Change this kid\u2019s PIN':'Set a PIN for this kid',
        body:'They\u2019ll use it to sign in and view the calendar (they can\u2019t change anything).',
        placeholder:'At least 4 digits', ok:'Save PIN' });
      if(pin===null) return;
      const v=(pin||'').trim();
      if(v.length<4){ toast('PIN must be at least 4 digits'); return; }
      try{
        await api('/api/kids/'+b.dataset.kidpin+'/pin',{method:'POST',body:{pin:v}});
        await refresh(); renderApp(); openSettings(); toast('PIN saved');
      }catch(e){ toast(e.error||'Could not save PIN'); }
    };
  });
  sheet.querySelectorAll('[data-kidpinoff]').forEach(b=>{
    b.onclick=async()=>{
      const yes=await ask({ title:'Turn off this kid\u2019s login?',
        body:'They won\u2019t be able to sign in until you set a new PIN.', input:false, ok:'Turn off', danger:true });
      if(!yes) return;
      await api('/api/kids/'+b.dataset.kidpinoff+'/pin',{method:'POST',body:{pin:null}});
      await refresh(); renderApp(); openSettings(); toast('Login turned off');
    };
  });
  $('#n-save').onclick=async()=>{
    try{
      await api('/api/me',{method:'POST',body:{email:$('#n-email').value.trim(), notify:$('#n-on').checked}});
      await refresh(); renderApp(); openSettings(); toast('Notification settings saved');
    }catch(e){ $('#n-err').textContent=e.error||'Could not save'; }
  };
}

boot().catch(e=>{ $('#app').innerHTML='<div class="gate"><div class="gate-card">Could not reach the server. Refresh to try again.</div></div>'; });
