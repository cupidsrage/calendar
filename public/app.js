/* ============ boot / routing ============ */
async function boot(){
  clearInterval(pollTimer);
  setOnline();
  const state = await api('/api/state');
  if (state.needsSetup) return renderSetup();
  if (!token || !me) return renderLogin(state.parents);
  await refresh();
  renderApp();
  // Poll while the app is actually on screen; pause in the background to save battery.
  pollTimer = setInterval(async ()=>{
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
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
function renderLogin(parents){
  let sel = parents[0]?.id;
  $('#app').innerHTML = `
  <div class="gate"><div class="gate-card" style="max-width:420px">
    <h1 class="display">Our Calendar</h1>
    <p class="sub">Who's signing in?</p>
    <div class="login-choice">
      ${parents.map(p=>`
      <button class="login-parent ${p.id===sel?'sel':''}" data-id="${p.id}" style="border-color:${p.id===sel?p.color:''}">
        <span class="dot" style="background:${p.color}"></span>${esc(p.name)}
      </button>`).join('')}
    </div>
    <div class="field"><label>PIN</label><input id="l-pin" type="password" inputmode="numeric" placeholder="••••"></div>
    <button class="btn primary" id="l-go" style="width:100%">Sign in</button>
    <div class="err" id="l-err"></div>
  </div></div>`;
  document.querySelectorAll('.login-parent').forEach(b=>{
    b.onclick=()=>{ sel=+b.dataset.id;
      document.querySelectorAll('.login-parent').forEach(x=>{x.classList.remove('sel'); x.style.borderColor='';});
      b.classList.add('sel'); b.style.borderColor=parents.find(p=>p.id===sel).color;
    };
  });
  const go = async ()=>{
    try{
      const r = await api('/api/login',{method:'POST',body:{parent_id:sel,pin:$('#l-pin').value}});
      token=r.token; me=r.parent;
      localStorage.setItem('cc_token',token); localStorage.setItem('cc_me',JSON.stringify(me));
      boot();
    }catch(e){ $('#l-err').textContent=e.error||'Sign in failed'; }
  };
  $('#l-go').onclick=go;
  $('#l-pin').addEventListener('keydown',e=>{ if(e.key==='Enter') go(); });
}

/* ============ main app ============ */
function renderApp(preserve){
  const wasOpen = preserve && document.querySelector('.sheet.open')?.id;
  document.documentElement.style.setProperty('--p1', D.parents[0]?.color || '#2F6D62');
  document.documentElement.style.setProperty('--p2', D.parents[1]?.color || '#C0702A');
  const inboxCount = myInbox().length;

  $('#app').innerHTML = `
  <header class="app">
    <div class="brand display">Our Calendar <span class="who">signed in as ${esc(parent(D.me).name)}</span></div>
    <div class="monthnav">
      <button class="iconbtn" id="prev" aria-label="Previous month">‹</button>
      <div class="month display">${MONTHS[view.getMonth()]} ${view.getFullYear()}</div>
      <button class="iconbtn" id="next" aria-label="Next month">›</button>
      <button class="btn small" id="today">Today</button>
    </div>
    <button class="iconbtn" id="inbox" aria-label="Approvals">⏳${inboxCount?`<span class="badge">${inboxCount}</span>`:''}</button>
    <button class="iconbtn" id="settings" aria-label="Settings">⚙</button>
    <button class="btn small" id="signout">Sign out</button>
  </header>
  <div class="legend">
    ${D.parents.map(p=>`<span><i style="background:${p.color}"></i>${esc(p.name)}'s week</span>`).join('')}
    <span>⏳ waiting on approval</span>
    <span><i style="background:#9AA093"></i>unassigned</span>
    <span><i style="background:#fff;border:2px dashed var(--ink)"></i>swapped day</span>
    <span>🎂 birthday</span>
  </div>
  <div class="cal-wrap">
    <div class="dow">${DOWS.map(d=>`<div>${d}</div>`).join('')}</div>
    <div class="grid" id="grid"></div>
  </div>
  <div class="overlay" id="overlay"></div>
  <div class="sheet" id="daysheet"></div>
  <div class="sheet" id="inboxsheet"></div>
  <div class="sheet" id="setsheet"></div>`;

  renderGrid();
  $('#prev').onclick=()=>{ view.setMonth(view.getMonth()-1); refresh().then(()=>renderApp()); };
  $('#next').onclick=()=>{ view.setMonth(view.getMonth()+1); refresh().then(()=>renderApp()); };
  $('#today').onclick=()=>{ view=new Date(); view.setDate(1); refresh().then(()=>renderApp()); };
  $('#inbox').onclick=()=>openInbox();
  $('#settings').onclick=()=>openSettings();
  $('#signout').onclick=async()=>{ try{await api('/api/logout',{method:'POST'});}catch(e){} signOutLocal(); };
  $('#overlay').onclick=closeSheets;

  if (wasOpen==='daysheet' && openDate) openDay(openDate);
  else if (wasOpen==='inboxsheet') openInbox();
}

function renderGrid(){
  const y=view.getFullYear(), m=view.getMonth();
  const first=new Date(y,m,1).getDay(), days=new Date(y,m+1,0).getDate();
  const tstr=todayStr();
  let html='';
  for(let i=0;i<first;i++) html+=`<div class="day blank"></div>`;
  for(let d=1;d<=days;d++){
    const ds=`${y}-${pad(m+1)}-${pad(d)}`;
    const c=custodyFor(ds), cp=c.pid?parent(c.pid):null;
    const appts=itemsOn(ds);
    const shown=appts.slice(0,3);
    html+=`
    <button class="day ${ds===tstr?'today':''} ${c.pendingSwap?'pendingswap':''}" data-d="${ds}" style="${cp?`background:${tint(cp.color,.10)};`:''}">
      <span class="num">${d}</span>
      ${cp?`<span class="who ${c.override?'override':''}" style="background:${cp.color}">${esc(cp.name[0])}</span>`:''}
      ${c.pendingSwap?`<span class="swaptag">swap?</span>`:''}
      ${shown.map(a=>{
        if(a.type==='birthday')
          return `<span class="chip bday">🎂 ${esc(a.title)}</span>`;
        const bg=a.parent_id?parent(a.parent_id).color:'#9AA093';
        const unsettled=!a.confirmed||!!pendingFor(a.id);
        return `<span class="chip ${unsettled?'pending':''}" style="background:${bg}">
          ${unsettled?'⏳ ':''}${a.time?`<span class="t">${fmtTime(a.time)}</span>`:''}${esc(a.title)}</span>`;
      }).join('')}
      ${appts.length>3?`<span class="more">+${appts.length-3} more</span>`:''}
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
  const c=custodyFor(ds), cp=c.pid?parent(c.pid):null, o=other();
  const appts=itemsOn(ds);
  const ps=c.pendingSwap;
  const swapTarget = c.pid===D.parents[0].id?D.parents[1].id:D.parents[0].id;
  const sheet=$('#daysheet');

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
    $('#f-time').style.display   = t==='birthday'?'none':'';
    $('#f-parent').style.display = t==='birthday'?'none':'';
    $('#f-bdate').style.display  = t==='birthday'?'':'none';
    $('#a-title').placeholder = t==='birthday'?"e.g. Ava's birthday":t==='event'?'e.g. School play':'e.g. Dentist';
    syncOwner();
  };
  // Assigning the other parent turns this into a request that needs their OK.
  const syncOwner=()=>{
    const t=$('#a-type').value;
    const needsOk = t!=='birthday' && +$('#a-parent').value===o.id;
    $('#f-msg').style.display = needsOk?'':'none';
    $('#a-hint').textContent = needsOk
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
    const body={ type:t, title:$('#a-title').value.trim(), kid_id:+$('#a-kid').value||null,
                 date: t==='birthday' ? $('#a-bdate').value : ds,
                 time:$('#a-time').value||null, notes:$('#a-notes').value.trim()||null,
                 parent_id:+$('#a-parent').value||null,
                 message:$('#a-msg').value.trim()||null };
    if(!body.title){ $('#a-err').textContent='Give it a title.'; return; }
    if(t==='birthday'&&!body.date){ $('#a-err').textContent='Pick the birth date.'; return; }
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
  const baseActions=`<button class="btn small" data-act="edit" data-id="${a.id}">Edit</button>
                     <button class="btn small danger" data-act="del" data-id="${a.id}">Delete</button>`;

  if(a.type==='birthday'){
    const age=bdayAge(a, ds||a.date);
    return `<div class="appt">
      <div class="top"><b>&#127874; ${esc(a.title)}</b>${age?`<span>turning ${age}</span>`:''}</div>
      <div class="meta">${kid?esc(kid.name)+' &middot; ':''}repeats every year${a.notes?' &middot; '+esc(a.notes):''}</div>
      <div class="actions">${baseActions}</div>
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
    <div class="meta">${a.type==='event'?'Event &middot; ':''}${kid?esc(kid.name)+' &middot; ':''}${a.notes?esc(a.notes):''}</div>
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

/* ---- settings ---- */
function openSettings(){
  const sheet=$('#setsheet');
  const mine=parent(D.me);
  sheet.innerHTML=`
  <header><h2 class="display">Schedule & kids</h2><button class="x" aria-label="Close">✕</button></header>
  <div class="body">
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
    <div id="kidlist">${D.kids.map(k=>`<div class="kidrow"><span>${esc(k.name)}</span>
      <button class="btn small danger" data-kid="${k.id}">Remove</button></div>`).join('')||'<div class="empty">No kids added yet.</div>'}</div>
    <div class="addkid"><input id="k-name" placeholder="Kid's name"><button class="btn" id="k-add">Add</button></div>

    <div class="section-h">Email notifications</div>
    ${D.mailReady?'':`<div class="warn">Email isn't switched on yet. Add SMTP_HOST, SMTP_USER and SMTP_PASS in your Railway variables and redeploy — the settings below will start working right away.</div>`}
    <div class="field"><label>Your email</label><input id="n-email" type="email" placeholder="name@email.com" value="${esc(mine.email||'')}"></div>
    <label class="check"><input type="checkbox" id="n-on" ${mine.notify?'checked':''}> Email me when ${esc(other().name)} needs my OK or answers one of my requests</label>
    <button class="btn primary" id="n-save" style="width:100%; margin-top:10px">Save notification settings</button>
    <div class="err" id="n-err"></div>
    <p class="empty">You'll get an email when ${esc(other().name)} asks you to take an appointment, proposes a day swap, changes something you already agreed to, or answers one of your requests — plus a heads-up when she adds something that doesn't need your approval. ${other().email?`${esc(other().name)} has an email set${other().notify?' and notifications on':' but notifications off'}.`:`${esc(other().name)} hasn't added an email yet, so they won't get any.`}</p>
  </div>`;
  showSheet('#setsheet');
  sheet.querySelector('.x').onclick=closeSheets;
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
  $('#n-save').onclick=async()=>{
    try{
      await api('/api/me',{method:'POST',body:{email:$('#n-email').value.trim(), notify:$('#n-on').checked}});
      await refresh(); renderApp(); openSettings(); toast('Notification settings saved');
    }catch(e){ $('#n-err').textContent=e.error||'Could not save'; }
  };
}

boot().catch(e=>{ $('#app').innerHTML='<div class="gate"><div class="gate-card">Could not reach the server. Refresh to try again.</div></div>'; });
