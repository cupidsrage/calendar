/* ============ boot / routing ============ */
async function boot(){
  clearInterval(pollTimer);
  const state = await api('/api/state');
  if (state.needsSetup) return renderSetup();
  if (!token || !me) return renderLogin(state.parents);
  await refresh();
  renderApp();
  pollTimer = setInterval(async ()=>{ try{ await refresh(); renderApp(true); }catch(e){} }, 25000);
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
  const inboxCount = D.requests.filter(r=>r.status==='pending' && r.to_parent===D.me).length;

  $('#app').innerHTML = `
  <header class="app">
    <div class="brand display">Our Calendar <span class="who">signed in as ${esc(parent(D.me).name)}</span></div>
    <div class="monthnav">
      <button class="iconbtn" id="prev" aria-label="Previous month">‹</button>
      <div class="month display">${MONTHS[view.getMonth()]} ${view.getFullYear()}</div>
      <button class="iconbtn" id="next" aria-label="Next month">›</button>
      <button class="btn small" id="today">Today</button>
    </div>
    <button class="iconbtn" id="inbox" aria-label="Coverage requests">⇄${inboxCount?`<span class="badge">${inboxCount}</span>`:''}</button>
    <button class="iconbtn" id="settings" aria-label="Settings">⚙</button>
    <button class="btn small" id="signout">Sign out</button>
  </header>
  <div class="legend">
    ${D.parents.map(p=>`<span><i style="background:${p.color}"></i>${esc(p.name)}'s day</span>`).join('')}
    <span><i style="background:#fff;border:2px dashed #999"></i>coverage pending</span>
    <span><i style="background:#fff;border:2px dashed var(--ink)"></i>switched day</span>
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
    const appts=D.appointments.filter(a=>a.date===ds);
    const shown=appts.slice(0,3);
    html+=`
    <button class="day ${ds===tstr?'today':''}" data-d="${ds}" style="${cp?`background:${tint(cp.color,.10)};`:''}">
      <span class="num">${d}</span>
      ${cp?`<span class="who ${c.override?'override':''}" style="background:${cp.color}">${esc(cp.name[0])}</span>`:''}
      ${shown.map(a=>{
        const owner=parent(a.covered_by||a.parent_id);
        const pend=D.requests.some(r=>r.appointment_id===a.id&&r.status==='pending');
        return `<span class="chip ${pend?'pending':''}" style="background:${owner.color}">
          ${a.covered_by?'⇄ ':''}${a.time?`<span class="t">${fmtTime(a.time)}</span>`:''}${esc(a.title)}</span>`;
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
  const appts=D.appointments.filter(a=>a.date===ds);
  const sheet=$('#daysheet');
  sheet.innerHTML=`
  <header><h2 class="display">${fmtDate(ds)}</h2><button class="x" aria-label="Close">✕</button></header>
  <div class="body">
    <div class="custody-row">
      ${cp?`<span class="custody-tag" style="background:${cp.color}">${esc(cp.name)}'s day${c.override?' (switched)':''}</span>`
          :`<span class="empty">No custody set for this weekday</span>`}
      ${cp?`<button class="btn small" id="d-switch">Switch to ${esc(parent(c.pid===D.parents[0].id?D.parents[1].id:D.parents[0].id).name)}</button>`:''}
      ${c.override?`<button class="btn small" id="d-reset">Back to normal schedule</button>`:''}
    </div>

    <div class="section-h">Appointments</div>
    ${appts.length?appts.map(a=>apptCard(a)).join(''):`<div class="empty">Nothing scheduled.</div>`}

    <div class="section-h">${editingId?'Edit appointment':'Add appointment'}</div>
    <div class="field"><label>Title</label><input id="a-title" placeholder="e.g. Dentist"></div>
    <div class="field"><label>Kid</label>
      <select id="a-kid"><option value="">—</option>${D.kids.map(k=>`<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Time</label><input id="a-time" type="time"></div>
    <div class="field"><label>Who's taking them</label>
      <select id="a-parent">${D.parents.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Notes</label><textarea id="a-notes" rows="2" placeholder="Address, what to bring…"></textarea></div>
    <div style="display:flex; gap:8px">
      <button class="btn primary" id="a-save">${editingId?'Save changes':'Add appointment'}</button>
      ${editingId?`<button class="btn" id="a-cancel">Cancel edit</button>`:''}
    </div>
    <div class="err" id="a-err"></div>
  </div>`;
  showSheet('#daysheet');
  sheet.querySelector('.x').onclick=closeSheets;
  $('#a-parent').value = c.pid || D.me;

  if (editingId){
    const a=D.appointments.find(x=>x.id===editingId);
    if(a){ $('#a-title').value=a.title; $('#a-kid').value=a.kid_id||''; $('#a-time').value=a.time||'';
           $('#a-parent').value=a.parent_id; $('#a-notes').value=a.notes||''; }
    $('#a-cancel').onclick=()=>{ editingId=null; openDay(ds); };
  }

  if($('#d-switch')) $('#d-switch').onclick=async()=>{
    const to = c.pid===D.parents[0].id?D.parents[1].id:D.parents[0].id;
    await api('/api/override',{method:'POST',body:{date:ds,parent_id:to}});
    await refresh(); renderApp(); openDay(ds); toast('Day switched');
  };
  if($('#d-reset')) $('#d-reset').onclick=async()=>{
    await api('/api/override',{method:'POST',body:{date:ds,parent_id:null}});
    await refresh(); renderApp(); openDay(ds); toast('Back to normal schedule');
  };

  $('#a-save').onclick=async()=>{
    const body={ title:$('#a-title').value.trim(), kid_id:+$('#a-kid').value||null, date:ds,
                 time:$('#a-time').value||null, notes:$('#a-notes').value.trim()||null, parent_id:+$('#a-parent').value };
    if(!body.title){ $('#a-err').textContent='Give it a title.'; return; }
    try{
      if(editingId) await api('/api/appointments/'+editingId,{method:'PUT',body});
      else await api('/api/appointments',{method:'POST',body});
      editingId=null; await refresh(); renderApp(); openDay(ds); toast('Saved');
    }catch(e){ $('#a-err').textContent=e.error||'Could not save'; }
  };

  sheet.querySelectorAll('[data-act]').forEach(b=>{
    const id=+b.dataset.id, act=b.dataset.act;
    b.onclick=async()=>{
      try{
        if(act==='edit'){ editingId=id; openDay(ds); return; }
        if(act==='del'){ await api('/api/appointments/'+id,{method:'DELETE'}); toast('Deleted'); }
        if(act==='ask'){
          const msg=prompt(`Message to ${o.name} (optional):`,'');
          if(msg===null) return;
          await api('/api/requests',{method:'POST',body:{appointment_id:id,message:msg.trim()||null}});
          toast(`Asked ${o.name} to cover`);
        }
        if(act==='cancelreq'){ await api('/api/requests/'+id+'/cancel',{method:'POST'}); toast('Request cancelled'); }
        if(act==='accept'){ await api('/api/requests/'+id+'/respond',{method:'POST',body:{accept:true}}); toast("You've got it covered"); }
        if(act==='decline'){ await api('/api/requests/'+id+'/respond',{method:'POST',body:{accept:false}}); toast('Declined'); }
        await refresh(); renderApp(); openDay(ds);
      }catch(e){ toast(e.error||'Something went wrong'); }
    };
  });
}

function apptCard(a){
  const owner=parent(a.parent_id), kid=D.kids.find(k=>k.id===a.kid_id);
  const pend=D.requests.find(r=>r.appointment_id===a.id&&r.status==='pending');
  const mine=(a.covered_by||a.parent_id)===D.me;
  let swap='';
  if(a.covered_by) swap=`<div class="swap">⇄ Covered by ${esc(parent(a.covered_by).name)}</div>`;
  else if(pend) swap=`<div class="swap pending">⇄ Waiting on ${esc(parent(pend.to_parent).name)} to respond</div>`;
  let actions=`<button class="btn small" data-act="edit" data-id="${a.id}">Edit</button>
               <button class="btn small danger" data-act="del" data-id="${a.id}">Delete</button>`;
  if(pend && pend.to_parent===D.me)
    actions=`<button class="btn small primary" data-act="accept" data-id="${pend.id}">I'll cover it</button>
             <button class="btn small" data-act="decline" data-id="${pend.id}">Can't</button>`+actions;
  else if(pend && pend.from_parent===D.me)
    actions=`<button class="btn small" data-act="cancelreq" data-id="${pend.id}">Cancel request</button>`+actions;
  else if(mine && !a.covered_by)
    actions=`<button class="btn small" data-act="ask" data-id="${a.id}">Ask ${esc(other().name)} to cover</button>`+actions;
  return `<div class="appt">
    <div class="top"><b>${esc(a.title)}</b>${a.time?`<span>${fmtTime(a.time)}</span>`:''}</div>
    <div class="meta">${kid?esc(kid.name)+' · ':''}${a.notes?esc(a.notes):''}</div>
    <span class="own" style="background:${owner.color}">${esc(owner.name)} is taking them</span>
    ${swap}<div class="actions">${actions}</div>
  </div>`;
}

/* ---- inbox ---- */
function openInbox(){
  const mine=D.requests.filter(r=>r.status==='pending'&&r.to_parent===D.me);
  const sent=D.requests.filter(r=>r.status==='pending'&&r.from_parent===D.me);
  const done=D.requests.filter(r=>r.status!=='pending').slice(0,10);
  const sheet=$('#inboxsheet');
  const card=(r,kind)=>{
    const kid=D.kids.find(k=>k.id===r.kid_id);
    return `<div class="req">
      <div class="head">${esc(r.title)}</div>
      <div class="meta">${fmtDate(r.date)}${r.time?' · '+fmtTime(r.time):''}${kid?' · '+esc(kid.name):''}</div>
      ${r.message?`<div class="msg">"${esc(r.message)}"</div>`:''}
      ${kind==='in'?`<div class="actions">
          <button class="btn small primary" data-r="${r.id}" data-a="accept">I'll cover it</button>
          <button class="btn small" data-r="${r.id}" data-a="decline">Can't</button></div>`
      :kind==='out'?`<div class="actions"><span class="meta">Waiting on ${esc(parent(r.to_parent).name)}</span>
          <button class="btn small" data-r="${r.id}" data-a="cancel">Cancel</button></div>`
      :`<div class="status" style="color:${r.status==='accepted'?'#2F6D62':'var(--muted)'}">${r.status}${r.status==='accepted'?' · '+esc(parent(r.to_parent).name)+' covered it':''}</div>`}
    </div>`;
  };
  sheet.innerHTML=`
  <header><h2 class="display">Coverage requests</h2><button class="x" aria-label="Close">✕</button></header>
  <div class="body">
    <div class="section-h">Needs your answer</div>
    ${mine.length?mine.map(r=>card(r,'in')).join(''):'<div class="empty">Nothing waiting on you.</div>'}
    <div class="section-h">You asked</div>
    ${sent.length?sent.map(r=>card(r,'out')).join(''):'<div class="empty">No open requests.</div>'}
    <div class="section-h">Recent</div>
    ${done.length?done.map(r=>card(r,'hist')).join(''):'<div class="empty">No history yet.</div>'}
  </div>`;
  showSheet('#inboxsheet');
  sheet.querySelector('.x').onclick=closeSheets;
  sheet.querySelectorAll('[data-r]').forEach(b=>{
    b.onclick=async()=>{
      const id=b.dataset.r, a=b.dataset.a;
      try{
        if(a==='cancel') await api('/api/requests/'+id+'/cancel',{method:'POST'});
        else await api('/api/requests/'+id+'/respond',{method:'POST',body:{accept:a==='accept'}});
        await refresh(); renderApp(); openInbox();
        toast(a==='accept'?"You've got it covered":a==='decline'?'Declined':'Cancelled');
      }catch(e){ toast(e.error||'Something went wrong'); }
    };
  });
}

/* ---- settings ---- */
function openSettings(){
  const sheet=$('#setsheet');
  sheet.innerHTML=`
  <header><h2 class="display">Schedule & kids</h2><button class="x" aria-label="Close">✕</button></header>
  <div class="body">
    <div class="section-h">Normal week — whose day is it?</div>
    <div class="patt">
      ${DOWS.map((d,i)=>{
        const cur=D.pattern.find(p=>p.weekday===i)?.parent_id||'';
        return `<div class="cell">${d}<select data-wd="${i}">
          <option value="">—</option>
          ${D.parents.map(p=>`<option value="${p.id}" ${p.id===cur?'selected':''}>${esc(p.name)}</option>`).join('')}
        </select></div>`;
      }).join('')}
    </div>
    <p class="empty" style="margin-bottom:6px">One-off switches are done from the day itself (open a day → Switch).</p>
    <div class="section-h">Kids</div>
    <div id="kidlist">${D.kids.map(k=>`<div class="kidrow"><span>${esc(k.name)}</span>
      <button class="btn small danger" data-kid="${k.id}">Remove</button></div>`).join('')||'<div class="empty">No kids added yet.</div>'}</div>
    <div class="addkid"><input id="k-name" placeholder="Kid's name"><button class="btn" id="k-add">Add</button></div>
  </div>`;
  showSheet('#setsheet');
  sheet.querySelector('.x').onclick=closeSheets;
  sheet.querySelectorAll('select[data-wd]').forEach(s=>{
    s.onchange=async()=>{
      await api('/api/pattern',{method:'POST',body:{weekday:+s.dataset.wd,parent_id:+s.value||null}});
      await refresh(); renderApp(); openSettings(); toast('Schedule updated');
    };
  });
  $('#k-add').onclick=async()=>{
    const name=$('#k-name').value.trim(); if(!name) return;
    await api('/api/kids',{method:'POST',body:{name}});
    await refresh(); renderApp(); openSettings();
  };
  sheet.querySelectorAll('[data-kid]').forEach(b=>{
    b.onclick=async()=>{
      if(!confirm('Remove this kid? Their appointments stay, just untagged.')) return;
      await api('/api/kids/'+b.dataset.kid,{method:'DELETE'});
      await refresh(); renderApp(); openSettings();
    };
  });
}

boot().catch(e=>{ $('#app').innerHTML='<div class="gate"><div class="gate-card">Could not reach the server. Refresh to try again.</div></div>'; });
