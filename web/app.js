const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state, view = 'streams', selected = null, saveForm, session = {}, accounts = [], updateStatus = {}, updateTimer;
const canEdit = () => ['Admin','Editor'].includes(session.user?.role);
async function api(path, method = 'GET', data) {
  const r = await fetch('/api/' + path, {method, headers: {'Content-Type':'application/json', ...(session.csrf_token ? {'X-CSRF-Token':session.csrf_token} : {})}, body: data === undefined ? undefined : JSON.stringify(data)});
  const body = await r.json();
  if (!r.ok) {
    if (r.status === 401 && session.user) { session = {}; state = null; $('#editor').close(); render(); }
    throw new Error(body.error || 'Request failed');
  }
  return body;
}
function error(e) { $('#error').textContent = e.message; $('#error').hidden = false; setTimeout(() => $('#error').hidden = true, 7000); }
async function refresh() {
  session = await api('session');
  if (!session.user) { state=null; render(); return; }
  if (session.user.role !== 'Admin' && ['accounts','updates'].includes(view)) view='streams';
  state = await api('data');
  if (view === 'accounts') accounts = await api('users');
  if (view === 'updates') updateStatus = await api('updates');
  render();
}
const steps = id => state.steps.filter(s => s.stream_id === id).sort((a,b) => a.position - b.position || a.id - b.id);
const duration = n => `${Number(n.toFixed(1))} min`;
function stats(items) {
  const work = items.reduce((n,s) => n+s.work_minutes, 0), wait = items.reduce((n,s) => n+s.wait_minutes,0);
  return `<div class="stats"><div class="stat"><div class="label">Total lead time</div><strong>${duration(work+wait)}</strong><span>Work time + waiting time</span></div><div class="stat"><div class="label">Work time</div><strong>${duration(work)}</strong><span>Time spent actively delivering</span></div><div class="stat"><div class="label">Flow efficiency</div><strong>${work+wait ? Math.round(work/(work+wait)*100) : 0}%</strong><span>Work time / total lead time</span></div></div>`;
}
function renderContent() {
  $('#streamsNav').classList.toggle('active', view === 'streams');
  $('#processNav').classList.toggle('active', view === 'processes');
  $('#breadcrumb').textContent = view === 'processes' ? 'Process library' : selected ? 'Value stream map' : 'Value streams';
  if (view === 'processes') return renderProcesses();
  if (selected) return renderStream();
  $('#content').innerHTML = `<div class="eyebrow">SEE THE BIGGER PICTURE</div><div class="title-row"><div><h1>Value streams</h1><p>Connect the work you do to the value your customers receive.</p></div><button class="primary" data-action="new-stream">+ Create value stream</button></div><div class="stats"><div class="stat"><div class="label">Value streams</div><strong>${state.streams.length}</strong><span>Customer journeys mapped</span></div><div class="stat"><div class="label">Delivery steps</div><strong>${state.steps.length}</strong><span>Across your value streams</span></div><div class="stat"><div class="label">Processes</div><strong>${state.processes.length}</strong><span>In your process library</span></div></div><div class="section-row"><h2>Your value streams</h2><span class="label">${state.streams.length} streams</span></div>${state.streams.length ? `<div class="grid">${state.streams.map(s => `<article class="stream-card"><div class="card-head"><span class="icon">▱</span><span class="pill">${steps(s.id).length} steps</span></div><div><h3>${esc(s.name)}</h3><p>${esc(s.outcome || s.description || 'Define the outcome this stream delivers.')}</p></div><div class="card-meta"><span>${esc(s.customer || 'Customer not defined')}</span><button class="text-button" data-action="open-stream" data-id="${s.id}">Open map →</button></div></article>`).join('')}</div>` : `<div class="empty"><span class="icon">▱</span><h2>Start with a customer outcome</h2><p>Map how your team turns a request into a valuable service.<br>Try employee onboarding, incident resolution, or a cloud service request.</p><button class="primary" data-action="new-stream">+ Create your first stream</button></div>`}`;
}
function renderStream() {
  const stream = state.streams.find(s => s.id === selected);
  if (!stream) {selected=null;return render();}
  const items = steps(selected);
  $('#content').innerHTML = `<button class="text-button" data-action="back">← All value streams</button><div class="title-row"><div><h1>${esc(stream.name)}</h1><p>${esc(stream.description || 'Follow the journey from customer need to delivered value.')}</p></div><div class="detail-actions"><button data-action="edit-stream">Edit details</button><button class="primary" data-action="new-step">+ Add step</button><button class="danger" data-action="delete-stream">Delete</button></div></div><div class="context"><div><b>CUSTOMER / BENEFICIARY</b>${esc(stream.customer || 'Not defined')}</div><div><b>DESIRED OUTCOME</b>${esc(stream.outcome || 'Not defined')}</div></div>${stats(items)}<div class="section-row"><h2>Delivery flow</h2><span class="pill">Current state</span></div><div class="canvas"><div class="flow">${items.length ? items.map((s,i) => `${i ? '<div class="arrow">→</div>' : ''}<article class="step" draggable="true" data-id="${s.id}"><div class="step-number">STEP ${String(i+1).padStart(2,'0')} · DRAG TO REORDER</div><h3>${esc(s.name)}</h3><p>${esc(s.owner || 'No owner assigned')}</p><div class="timing"><div>Work time<b>${duration(s.work_minutes)}</b></div><div>Wait time<b>${duration(s.wait_minutes)}</b></div></div>${state.step_processes.filter(l => l.step_id === s.id).map(l => `<div class="linked">☷ ${esc(state.processes.find(p=>p.id===l.process_id)?.name)}</div>`).join('')}<div class="step-actions"><button class="text-button" data-action="edit-step" data-id="${s.id}">Edit</button><button class="text-button" data-action="link" data-id="${s.id}">Link processes</button><button class="text-button danger" data-action="delete-step" data-id="${s.id}" aria-label="Delete ${esc(s.name)}">×</button></div></article>`).join('') : '<p>No steps yet. Add the first activity in your service delivery journey.</p>'}<div class="arrow">→</div><button data-action="new-step">+ Add step</button></div></div><p class="hint">Drag cards to change the sequence. Link reusable processes to explain how each step is delivered. All times are measured in minutes.</p>`;
}
function renderProcesses() {
  $('#content').innerHTML = `<div class="eyebrow">MAKE DELIVERY REPEATABLE</div><div class="title-row"><div><h1>Process library</h1><p>Document how your services are delivered, then connect processes to your maps.</p></div><button class="primary" data-action="new-process">+ Create process</button></div>${state.processes.length ? `<div class="grid">${state.processes.map(p=>`<article class="process-card"><div class="card-head"><span class="icon">☷</span><span class="pill">${state.step_processes.filter(l=>l.process_id===p.id).length} linked steps</span></div><div><h3>${esc(p.name)}</h3><p>${esc(p.description || 'No description yet')}</p></div><div class="card-meta"><span>${esc(p.owner || 'No owner assigned')}</span><button class="text-button" data-action="edit-process" data-id="${p.id}">View / edit →</button></div><button class="text-button danger" data-action="delete-process" data-id="${p.id}">Delete process</button></article>`).join('')}</div>` : '<div class="empty"><h2>Your shared process library</h2><p>Create processes such as incident triage, change approval, or access provisioning.<br>A process can support multiple steps across value streams.</p></div>'}`;
}
const field = (name,label,value='',type='text') => `<label>${label}${type === 'textarea' ? `<textarea name="${name}">${esc(value)}</textarea>` : `<input name="${name}" type="${type}" value="${esc(value)}" ${name==='name'?'required maxlength="200"':''} ${type==='number'?'min="0" step="any" required':''}>`}</label>`;
function modal(title, html, save, readOnly=false) {
  $('#dialogTitle').textContent=title; $('#fields').innerHTML=html; saveForm=readOnly ? null : save;
  $('#form button[type="submit"]').hidden=readOnly;
  if(readOnly) $('#fields').querySelectorAll('input,textarea,select').forEach(el=>el.disabled=true);
  $('#editor').showModal();
}
function editStream(id) {
  const s = state.streams.find(s=>s.id===id) || {};
  modal(id?'Edit value stream':'Create value stream', field('name','Stream name',s.name) + field('customer','Customer / beneficiary',s.customer) + field('outcome','Desired customer outcome',s.outcome) + field('description','Description',s.description,'textarea'), async data => {
    const result = await api('streams'+(id?'/'+id:''),id?'PUT':'POST',data); selected=result.id;
  });
}
function editStep(id) {
  const s = state.steps.find(s=>s.id===id) || {work_minutes:0,wait_minutes:0};
  modal(id?'Edit step':'Add delivery step',field('name','Step name',s.name)+field('owner','Responsible team / owner',s.owner)+field('work_minutes','Active work time (minutes)',s.work_minutes,'number')+field('wait_minutes','Waiting time (minutes)',s.wait_minutes,'number'), async data=> {
    data.work_minutes=Number(data.work_minutes);data.wait_minutes=Number(data.wait_minutes);
    if (!id) {data.stream_id=selected;data.position=Math.max(-1,...steps(selected).map(s=>s.position))+1;}
    await api('steps'+(id?'/'+id:''),id?'PUT':'POST',data);
  });
}
function editProcess(id) {
  const p = state.processes.find(p=>p.id===id)||{};
  modal(id?'Process details':'Create process',field('name','Process name',p.name)+field('owner','Process owner',p.owner)+field('description','Purpose / description',p.description,'textarea')+field('procedure','Procedure / work instructions',p.procedure,'textarea'),data=>api('processes'+(id?'/'+id:''),id?'PUT':'POST',data), !canEdit());
}
$('#form').addEventListener('submit', async e=> {
  e.preventDefault();if(!saveForm)return;const button=e.submitter;button.disabled=true;
  try {await saveForm(Object.fromEntries(new FormData(e.target)));$('#editor').close();await refresh();}catch(e){error(e);}finally{button.disabled=false;}
});
$('#closeDialog').onclick=$('#cancelDialog').onclick=()=>$('#editor').close();
$('#editor').addEventListener('close',()=>{ $('#fields').replaceChildren(); saveForm=null; });
$('#streamsNav').onclick=()=>{view='streams';selected=null;render();};
$('#processNav').onclick=()=>{view='processes';render();};
$('#content').addEventListener('click', async e=> {
  const el=e.target.closest('[data-action]');if(!el)return;
  const id=Number(el.dataset.id);
  try {
    if(['new-stream','edit-stream','new-step','edit-step','new-process','link','delete-stream','delete-step','delete-process'].includes(el.dataset.action) && !canEdit()) return;
    if(el.dataset.action==='new-account') return editAccount();
    if(el.dataset.action==='edit-account') return editAccount(id);
    if(el.dataset.action==='delete-account') {
      if(!confirm('Remove this account? Its sessions will be revoked.'))return;
      await api('users/'+id,'DELETE'); await refresh(); return;
    }
    if(el.dataset.action==='check-update' || el.dataset.action==='install-update') {
      if(el.dataset.action==='install-update' && !confirm('Update to the latest GitHub main revision? A database backup will be made and the application will briefly restart.'))return;
      await api('updates/'+(el.dataset.action==='check-update'?'check':'install'),'POST',{});
      await refresh();return;
    }
    switch(el.dataset.action) {
      case 'new-stream':return editStream();case 'edit-stream':return editStream(selected);
      case 'open-stream':selected=id;return render();case 'back':selected=null;return render();
      case 'new-step':return editStep();case 'edit-step':return editStep(id);
      case 'new-process':return editProcess();case 'edit-process':return editProcess(id);
      case 'link':return modal('Link processes',state.processes.length?state.processes.map(p=>`<label class="check"><input type="checkbox" name="process_${p.id}" ${state.step_processes.some(l=>l.step_id===id&&l.process_id===p.id)?'checked':''}>${esc(p.name)}</label>`).join(''):'<p>Create a process in the Process library first.</p>',async data=>api(`steps/${id}/processes`,'PUT',{process_ids:Object.keys(data).map(k=>Number(k.slice(8)))}));
      case 'delete-stream':if(!confirm('Delete this stream and all its steps? Processes will remain in the library.'))return;await api('streams/'+selected,'DELETE');selected=null;break;
      case 'delete-step':if(!confirm('Delete this step?'))return;await api('steps/'+id,'DELETE');break;
      case 'delete-process':if(!confirm('Delete this process and remove all its links?'))return;await api('processes/'+id,'DELETE');break;
    }
    await refresh();
  }catch(e){error(e);}
});
let dragged;
$('#content').addEventListener('dragstart',e=>{const card=e.target.closest('.step');if(card && canEdit()){dragged=Number(card.dataset.id);e.dataTransfer.setData('text/plain',String(dragged));}});
$('#content').addEventListener('dragover',e=>{if(e.target.closest('.step'))e.preventDefault();});
$('#content').addEventListener('drop',async e=>{
  const target=e.target.closest('.step');if(!target||!dragged||!canEdit())return;e.preventDefault();
  const items=steps(selected),from=items.findIndex(s=>s.id===dragged),to=items.findIndex(s=>s.id===Number(target.dataset.id));
  if(from<0||to<0||from===to)return;
  items.splice(to,0,items.splice(from,1)[0]);
  try{for(let i=0;i<items.length;i++)await api('steps/'+items[i].id,'PUT',{position:i});await refresh();}catch(e){error(e);await refresh();}finally{dragged=null;}
});
function render() {
  clearTimeout(updateTimer);
  const user=session.user;
  document.body.classList.toggle('signed-out',!user);
  $('#adminMenu').hidden=user?.role!=='Admin';
  $('#identity').innerHTML=user?`<span>${esc(user.username)} <span class="pill">${esc(user.role)}</span></span><button id="logout" class="text-button">Sign out</button>`:'';
  if(user) $('#logout').onclick=async()=>{try{await api('auth/logout','POST',{});session={};selected=null;view='streams';await refresh();}catch(e){error(e);}};
  if(!user) return renderAuth();
  $('#accountsNav').classList.toggle('active',view==='accounts');
  $('#updatesNav').classList.toggle('active',view==='updates');
  if(view==='accounts') {$('#streamsNav').classList.remove('active');$('#processNav').classList.remove('active');return renderAccounts();}
  if(view==='updates') {$('#streamsNav').classList.remove('active');$('#processNav').classList.remove('active');return renderUpdates();}
  renderContent();
  if(!canEdit()) {
    $('#content').querySelectorAll('[data-action]').forEach(el=>{
      if(['new-stream','edit-stream','new-step','edit-step','new-process','link','delete-stream','delete-step','delete-process'].includes(el.dataset.action)) el.remove();
    });
    $('#content').querySelectorAll('[draggable]').forEach(el=>el.draggable=false);
    $('#content').querySelectorAll('.step-number').forEach(el=>el.textContent=el.textContent.replace(' · DRAG TO REORDER',''));
    $('#content').querySelectorAll('.hint').forEach(el=>el.textContent='Read-only access. All times are measured in minutes.');
    $('#content').querySelectorAll('[data-action="edit-process"]').forEach(el=>el.textContent='View details →');
  }
}
function credentialFields(username='', passwordRequired=true) {
  return `<label>Username<input name="username" aria-label="Username" value="${esc(username)}" required minlength="3" maxlength="64" autocomplete="username"><span class="hint">3–64 letters, numbers, dots, underscores or hyphens.</span></label><label>${passwordRequired?'Password':'New password (leave blank to keep current)'}<input name="password" aria-label="${passwordRequired?'Password':'New password'}" type="password" ${passwordRequired?'required':''} minlength="12" maxlength="128" autocomplete="new-password"><span class="hint">Use 12–128 characters.</span></label>`;
}
function renderAuth() {
  $('#breadcrumb').textContent='Local accounts';
  const setup=session.setup_required;
  $('#content').innerHTML=`<div class="auth-card"><span class="icon">◈</span><h1>${setup?'Create your Admin account':'Welcome back'}</h1><p>${setup?'The first account administers this local workspace. Additional accounts are created by an Admin.':'Sign in to your local VSM Toolbox workspace.'}</p><form id="authForm">${setup?credentialFields():`<label>Username<input name="username" autocomplete="username" required maxlength="64"></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>`}<button class="primary" type="submit">${setup?'Create Admin account':'Sign in'}</button><p id="authError" role="alert"></p></form></div>`;
  $('#authForm').onsubmit=async e=>{
    e.preventDefault();const button=e.submitter;button.disabled=true;
    try{session=await api('auth/'+(setup?'register':'login'),'POST',Object.fromEntries(new FormData(e.target)));await refresh();}
    catch(e){$('#authError').textContent=e.message;}finally{button.disabled=false;}
  };
}
function renderAccounts() {
  $('#breadcrumb').textContent='Administrator / Accounts';
  $('#content').innerHTML=`<div class="eyebrow">ADMINISTRATOR</div><div class="title-row"><div><h1>Account administration</h1><p>Manage local accounts and their access to this workspace.</p></div><button class="primary" data-action="new-account">+ Create Account</button></div><div class="role-guide"><div><b>Admin</b><p>Manage accounts, updates, and all content.</p></div><div><b>Editor</b><p>Create and edit streams and processes.</p></div><div><b>Viewer</b><p>Read streams and process documentation.</p></div></div><div class="section-row"><h2>Account Overview</h2><span class="label">${accounts.length} accounts</span></div><div class="table-wrap"><table><thead><tr><th>Username</th><th>Role</th><th>Actions</th></tr></thead><tbody>${accounts.map(u=>`<tr><td>${esc(u.username)} ${u.id===session.user.id?'<span class="pill">You</span>':''}</td><td><span class="pill">${esc(u.role)}</span></td><td><button class="text-button" data-action="edit-account" data-id="${u.id}">Edit</button><button class="text-button danger" data-action="delete-account" data-id="${u.id}">Remove</button></td></tr>`).join('')}</tbody></table></div><p class="hint">The last Admin cannot be removed or demoted. Editing an account revokes its existing sessions.</p>`;
}
function editAccount(id) {
  const u=accounts.find(u=>u.id===id)||{role:'Viewer'};
  modal(id?'Edit account':'Create Account',credentialFields(u.username,!id)+`<label>Role<select name="role" aria-label="Role">${['Admin','Editor','Viewer'].map(role=>`<option ${u.role===role?'selected':''}>${role}</option>`).join('')}</select></label>`,async data=>{
    if(id&&!data.password)delete data.password;
    await api('users'+(id?'/'+id:''),id?'PUT':'POST',data);
  });
}
function renderUpdates() {
  $('#breadcrumb').textContent='Administrator / Updates';
  const busy=['queued','checking','downloading','installing','restarting'].includes(updateStatus.state);
  $('#content').innerHTML=`<div class="eyebrow">ADMINISTRATOR</div><div class="title-row"><div><h1>Application updates</h1><p>Install the latest published revision of the GitHub main branch.</p></div><button data-action="check-update" ${busy||!updateStatus.available?'disabled':''}>Check for updates</button></div><div class="context update-panel"><div><b>INSTALLED REVISION</b><code>${esc(updateStatus.current_revision||'Local checkout')}</code></div><div><b>LATEST MAIN REVISION</b><code>${esc(updateStatus.latest_revision||'Not checked')}</code></div><div><b>STATUS</b><p role="status">${esc(updateStatus.message||'Ready to check for updates.')}</p></div><button class="primary" data-action="install-update" ${busy||!updateStatus.available?'disabled':''}>Update from main</button></div><p class="hint">A local database backup is made before installation. The application restarts briefly and checks its health; failed updates restore the previous code and database. Existing sessions are revoked after an update, so you may need to sign in again. GitHub connectivity is required only when checking or installing updates.</p>${!updateStatus.available?'<p>Web updates require the update supervisor. Install this version using the Debian installer or rebuild the Docker image once to enable them.</p>':''}`;
  if(busy) updateTimer=setTimeout(async()=>{try{updateStatus=await api('updates');if(view==='updates'&&session.user)render();}catch(e){updateTimer=setTimeout(()=>refresh().catch(error),2000);}},2000);
}
$('#accountsNav').onclick=()=>{view='accounts';selected=null;refresh().catch(error);};
$('#updatesNav').onclick=()=>{view='updates';selected=null;refresh().catch(error);};
refresh().catch(error);
