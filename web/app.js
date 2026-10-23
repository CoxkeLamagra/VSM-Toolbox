const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state, view = 'streams', selected = null, saveForm, session = {}, accounts = [], updateStatus = {}, updateTimer;
let backupState = {backups:[],operation:{}};
let streamMode = 'diagram', diagramController = null;
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
  if (session.user.role !== 'Admin' && ['accounts','updates','backups'].includes(view)) view='streams';
  state = await api('data');
  if (view === 'accounts') accounts = await api('users');
  if (view === 'backups') backupState = await api('backups');
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
  const flowMarkup = `<div class="canvas"><div class="flow">${items.length ? items.map((s,i) => `${i ? '<div class="arrow">→</div>' : ''}<article class="step" draggable="true" data-id="${s.id}"><div class="step-number">STEP ${String(i+1).padStart(2,'0')} · DRAG TO REORDER</div><h3>${esc(s.name)}</h3><p>${esc(s.owner || 'No owner assigned')}</p><div class="timing"><div>Work time<b>${duration(s.work_minutes)}</b></div><div>Wait time<b>${duration(s.wait_minutes)}</b></div></div>${state.step_processes.filter(l => l.step_id === s.id).map(l => `<div class="linked">☷ ${esc(state.processes.find(p=>p.id===l.process_id)?.name)}</div>`).join('')}<div class="step-actions"><button class="text-button" data-action="edit-step" data-id="${s.id}">Edit</button><button class="text-button" data-action="link" data-id="${s.id}">Link processes</button><button class="text-button danger" data-action="delete-step" data-id="${s.id}" aria-label="Delete ${esc(s.name)}">×</button></div></article>`).join('') : '<p>No steps yet. Add the first activity in your service delivery journey.</p>'}<div class="arrow">→</div><button data-action="new-step">+ Add step</button></div></div><p class="hint">Drag cards to change the sequence. Link reusable processes to explain how each step is delivered. All times are measured in minutes.</p>`;
  $('#content').innerHTML = `<button class="text-button" data-action="back">← All value streams</button><div class="title-row"><div><h1>${esc(stream.name)}</h1><p>${esc(stream.description || 'Follow the journey from customer need to delivered value.')}</p></div><div class="detail-actions"><button data-action="edit-stream">Edit details</button><button class="primary" data-action="new-step">+ Add step</button><button class="danger" data-action="delete-stream">Delete</button></div></div><div class="context"><div><b>CUSTOMER / BENEFICIARY</b>${esc(stream.customer || 'Not defined')}</div><div><b>DESIRED OUTCOME</b>${esc(stream.outcome || 'Not defined')}</div></div>${stats(items)}<div class="section-row"><h2>${streamMode === 'diagram' ? 'Value stream diagram' : 'Delivery flow'}</h2><div class="view-switch" role="group" aria-label="Stream view"><button data-action="diagram-view" aria-pressed="${streamMode === 'diagram'}">Diagram</button><button data-action="flow-view" aria-pressed="${streamMode === 'flow'}">Edit flow</button></div></div>${streamMode === 'diagram' ? diagramShell(items) : flowMarkup}`;
  if (streamMode === 'diagram' && items.length) diagramController = new StreamDiagram($('#streamDiagram'), items);
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
    if(el.dataset.action==='create-backup') {await api('backups/create','POST',{});await refresh();return;}
    if(el.dataset.action==='restore-backup') {
      if(!confirm('Restore application code, accounts and data from this trusted backup? Current data will be replaced. A safety backup is created first, and you must sign in again using an account from the backup.'))return;
      await api('backups/restore','POST',{id:el.dataset.backup});await refresh();return;
    }
    if(el.dataset.action==='cleanup-backups') {
      const ids=[...document.querySelectorAll('[name="backup-select"]:checked')].map(el=>el.value);
      if(!ids.length){error(new Error('Select backups to remove.'));return;}
      if(!confirm(`Permanently delete ${ids.length} selected backup(s)?`))return;
      await api('backups/cleanup','POST',{ids});await refresh();return;
    }
    if(el.dataset.action==='check-update' || el.dataset.action==='install-update') {
      if(el.dataset.action==='install-update' && !confirm('Update to the latest GitHub main revision? A database backup will be made and the application will briefly restart.'))return;
      await api('updates/'+(el.dataset.action==='check-update'?'check':'install'),'POST',{});
      await refresh();return;
    }
    switch(el.dataset.action) {
      case 'diagram-view':streamMode='diagram';return render();
      case 'flow-view':streamMode='flow';return render();
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
  diagramController?.destroy(); diagramController=null;
  clearTimeout(updateTimer);
  const user=session.user;
  document.body.classList.toggle('signed-out',!user);
  $('#adminMenu').hidden=user?.role!=='Admin';
  $('#identity').innerHTML=user?`<span>${esc(user.username)} <span class="pill">${esc(user.role)}</span></span><button id="logout" class="text-button">Sign out</button>`:'';
  if(user) $('#logout').onclick=async()=>{try{await api('auth/logout','POST',{});session={};selected=null;view='streams';await refresh();}catch(e){error(e);}};
  if(!user) return renderAuth();
  $('#accountsNav').classList.toggle('active',view==='accounts');
  $('#backupsNav').classList.toggle('active',view==='backups');
  if(view==='backups') {$('#streamsNav').classList.remove('active');$('#processNav').classList.remove('active');return renderBackups();}
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
    $('#content').querySelectorAll('.hint:not(.diagram-help)').forEach(el=>el.textContent='Read-only access. All times are measured in minutes.');
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
  const busy=['queued','checking','downloading','installing','restarting','backing-up','restoring','cleaning'].includes(updateStatus.state);
  $('#content').innerHTML=`<div class="eyebrow">ADMINISTRATOR</div><div class="title-row"><div><h1>Application updates</h1><p>Install the latest published revision of the GitHub main branch.</p></div><button data-action="check-update" ${busy||!updateStatus.available?'disabled':''}>Check for updates</button></div><div class="context update-panel"><div><b>INSTALLED REVISION</b><code>${esc(updateStatus.current_revision||'Local checkout')}</code></div><div><b>LATEST MAIN REVISION</b><code>${esc(updateStatus.latest_revision||'Not checked')}</code></div><div><b>STATUS</b><p role="status">${esc(updateStatus.message||'Ready to check for updates.')}</p></div><button class="primary" data-action="install-update" ${busy||!updateStatus.available||updateStatus.backup_protocol!==1?'disabled':''}>Update from main</button></div><p class="hint">A complete application and database backup is made before installation. The application restarts briefly and checks its health; failed updates restore the previous code and database. Existing sessions are revoked after an update, so you may need to sign in again. GitHub connectivity is required only when checking or installing updates.</p>${updateStatus.available&&updateStatus.backup_protocol!==1?'<p>Install the updated supervisor using the Debian installer or Docker image to guarantee full application backups before updating.</p>':''}${!updateStatus.available?'<p>Web updates require the update supervisor. Install this version using the Debian installer or rebuild the Docker image once to enable them.</p>':''}`;
  if(busy) updateTimer=setTimeout(async()=>{try{updateStatus=await api('updates');if(view==='updates'&&session.user)render();}catch(e){updateTimer=setTimeout(()=>refresh().catch(error),2000);}},2000);
}
function renderBackups() {
  $('#breadcrumb').textContent='Administrator / Backups & restore';
  const operation=backupState.operation||{},busy=['queued','checking','downloading','installing','restarting','backing-up','restoring','cleaning'].includes(operation.state);
  const disabled=busy||!operation.available||!backupState.supported;
  const size=n=>n<1024*1024?(n/1024).toFixed(1)+' KiB':(n/1024/1024).toFixed(1)+' MiB';
  $('#content').innerHTML=`<div class="eyebrow">ADMINISTRATOR</div><div class="title-row"><div><h1>Backups & restore</h1><p>Protect your application, accounts, and value stream data.</p></div><button class="primary" data-action="create-backup" ${disabled?'disabled':''}>Create manual backup</button></div><div class="context update-panel"><div><b>OPERATION STATUS</b><p role="status">${esc(operation.message||'Ready')}</p></div><div><b>RESTORE AN UPLOADED BACKUP</b><p>Upload a trusted .vsm-backup.zip file (up to 128 MiB). The file is validated before restoration. Backups contain application code and account data.</p><label>Backup file<input id="backupUpload" type="file" accept=".zip" ${disabled?'disabled':''}></label><button id="uploadBackup" ${disabled?'disabled':''}>Upload and restore</button></div>${!backupState.supported?'<p>Enable the updated supervisor with the Debian installer or Docker image before using backup management.</p>':''}</div><div class="section-row"><h2>Saved backups</h2><button class="danger" data-action="cleanup-backups" ${disabled?'disabled':''}>Delete selected backups</button></div><div class="table-wrap"><table><thead><tr><th>Select</th><th>Created / reason</th><th>Revision</th><th>Size</th><th>Actions</th></tr></thead><tbody>${backupState.backups.map(b=>`<tr><td><input aria-label="Select ${esc(b.id)}" type="checkbox" name="backup-select" value="${esc(b.id)}" ${disabled||b.protected?'disabled':''}></td><td>${esc(new Date(b.created_at*1000).toLocaleString())}<p>${esc(b.reason||'Backup')}</p></td><td><code>${esc(b.revision||'Legacy database backup')}</code></td><td>${size(b.size)}</td><td><a href="/api/backups/${encodeURIComponent(b.id)}/download" download>Download</a> <button class="text-button" data-action="restore-backup" data-backup="${esc(b.id)}" ${disabled||!b.restorable?'disabled':''}>Restore</button></td></tr>`).join('')||'<tr><td colspan="5">No backups yet. Create a manual backup to get started.</td></tr>'}</tbody></table></div><p class="hint">Every update and restore creates a safety backup before changing the application. Backups needed by an active recovery cannot be deleted. Download important backups to another system; local backups do not protect against disk loss. Restoring revokes sessions and restores the accounts and passwords contained in that backup.</p>`;
  $('#uploadBackup').onclick=async()=>{
    const file=$('#backupUpload').files[0];if(!file){error(new Error('Choose a backup file first.'));return;}
    if(file.size>128*1024*1024){error(new Error('Backup exceeds 128 MiB.'));return;}
    if(!confirm('Only restore a trusted application backup. This installs its application code and replaces current accounts and data. A safety backup will be created first. Continue?'))return;
    const button=$('#uploadBackup');button.disabled=true;
    try {
      const response=await fetch('/api/backups/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':session.csrf_token},body:file});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Upload failed');
      await api('backups/restore','POST',{id:result.id});await refresh();
    } catch(e){error(e);button.disabled=false;}
  };
  if(busy)updateTimer=setTimeout(()=>refresh().catch(e=>{if(session.user)updateTimer=setTimeout(()=>refresh().catch(error),2000);}),2000);
}
$('#backupsNav').onclick=()=>{view='backups';selected=null;refresh().catch(error);};
$('#accountsNav').onclick=()=>{view='accounts';selected=null;refresh().catch(error);};
$('#updatesNav').onclick=()=>{view='updates';selected=null;refresh().catch(error);};
// Diagram positions are a personal view; they never change delivery order or process links.
const diagramLayouts = new Map();
function diagramShell(items) {
  if (!items.length) return '<div class="empty"><h2>No delivery steps yet</h2><p>Add a step to start mapping your value stream and its processes.</p><button data-action="new-step">+ Add step</button></div>';
  const ids = new Set(items.map(s=>s.id));
  const linked = new Set(state.step_processes.filter(l=>ids.has(l.step_id)).map(l=>l.process_id));
  return `<div class="diagram-frame"><div class="diagram-toolbar"><div class="diagram-legend"><span><i class="legend-step"></i>Delivery steps <b>${items.length}</b></span><span><i class="legend-process"></i>Linked processes <b>${linked.size}</b></span></div><div class="diagram-controls" role="group" aria-label="Diagram controls"><button data-diagram="zoom-out" aria-label="Zoom out" title="Zoom out (−)">−</button><output id="diagramZoom" aria-label="Zoom level">100%</output><button data-diagram="zoom-in" aria-label="Zoom in" title="Zoom in (+)">+</button><button data-diagram="fit">Fit to screen</button><button data-diagram="reset">Reset layout</button></div></div><svg id="streamDiagram" class="stream-diagram" role="region" aria-label="Interactive value stream diagram" aria-describedby="diagramHelp" tabindex="0"><defs><pattern id="diagramGrid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" class="diagram-dot"/></pattern><marker id="flowArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs><rect width="100%" height="100%" fill="url(#diagramGrid)"/><g class="diagram-scene"><g class="diagram-edges"></g><g class="diagram-nodes"></g></g></svg></div><p id="diagramHelp" class="hint diagram-help">Drag the background to pan; drag a card to arrange it. Scroll or pinch to zoom. Double-click a step or process for details. With the diagram focused, use + / − to zoom and 0 to fit; use arrow keys to pan, or to move a focused card. Layout is saved in this browser. Delivery order is managed in Edit flow.</p>`;
}

class StreamDiagram {
  constructor(svg, items) {
    this.svg = svg;
    this.frame = svg.closest('.diagram-frame');
    this.scene = svg.querySelector('.diagram-scene');
    this.storageKey = `vsm-diagram-v1:${session.user.id}:${selected}`;
    this.nodes = new Map();
    this.edges = [];
    this.pointers = new Map();
    this.gesture = null;
    this.camera = {x:0,y:0,scale:1};
    this.listeners = new AbortController();
    const stream = state.streams.find(s=>s.id===selected);
    this.addNode({key:'customer',kind:'terminal',x:40,y:100,w:220,h:130,name:stream.customer||'Customer need',caption:'CUSTOMER / BENEFICIARY'});
    items.forEach((step,i)=>this.addNode({key:`step-${step.id}`,kind:'step',id:step.id,x:340+i*340,y:80,w:260,h:170,name:step.name,owner:step.owner,
      caption:`STEP ${String(i+1).padStart(2,'0')}`,work:step.work_minutes,wait:step.wait_minutes}));
    this.addNode({key:'outcome',kind:'terminal',x:340+items.length*340,y:100,w:220,h:130,name:stream.outcome||'Value delivered',caption:'CUSTOMER OUTCOME'});
    const sequence = ['customer',...items.map(s=>`step-${s.id}`),'outcome'];
    sequence.slice(1).forEach((key,i)=>this.edges.push({from:sequence[i],to:key,kind:'flow'}));
    const rows = new Map(), processes = new Map(state.processes.map(p=>[p.id,p]));
    const stepIndexes = new Map(items.map((s,i)=>[s.id,i]));
    const links = state.step_processes.filter(l=>stepIndexes.has(l.step_id)&&processes.has(l.process_id));
    links.forEach(link=>{
      const key = `process-${link.process_id}`;
      if(!this.nodes.has(key)) {
        const p=processes.get(link.process_id),column=stepIndexes.get(link.step_id),row=rows.get(column)||0,count=links.filter(l=>l.process_id===p.id).length;
        rows.set(column,row+1);
        this.addNode({key,kind:'process',id:p.id,x:350+column*340,y:350+row*180,w:240,h:140,name:p.name,owner:p.owner,description:p.description,
          caption:`PROCESS · ${count} LINKED ${count===1?'STEP':'STEPS'}`});
      }
      this.edges.push({from:`step-${link.step_id}`,to:key,kind:'process'});
    });
    this.defaults = new Map([...this.nodes].map(([key,n])=>[key,{x:n.x,y:n.y}]));
    const saved = this.load();
    for(const [key,position] of Object.entries(saved.positions||{})) {
      if(this.nodes.has(key)&&this.validPoint(position)) Object.assign(this.nodes.get(key),{x:position.x,y:position.y});
    }
    this.restoreCamera = this.validPoint(saved.camera)&&Number.isFinite(saved.camera.scale)&&saved.camera.scale>=.02&&saved.camera.scale<=2.5;
    if(this.restoreCamera) this.camera={x:saved.camera.x,y:saved.camera.y,scale:saved.camera.scale};
    this.draw();
    const signal = this.listeners.signal;
    svg.addEventListener('pointerdown',e=>this.pointerDown(e),{signal});
    svg.addEventListener('pointermove',e=>this.pointerMove(e),{signal});
    svg.addEventListener('pointerup',e=>this.pointerUp(e),{signal});
    svg.addEventListener('pointercancel',e=>this.pointerUp(e),{signal});
    svg.addEventListener('wheel',e=>{e.preventDefault();this.zoom(Math.exp(-Math.max(-200,Math.min(200,e.deltaY))*.003),this.point(e));this.save();},{passive:false,signal});
    svg.addEventListener('dblclick',e=>{const node=e.target.closest('[data-node-key]');if(node)this.details(this.nodes.get(node.dataset.nodeKey));},{signal});
    svg.addEventListener('keydown',e=>this.keyDown(e),{signal});
    this.frame.querySelector('.diagram-controls').addEventListener('click',e=>{
      const action=e.target.closest('[data-diagram]')?.dataset.diagram;
      if(action==='zoom-in')this.zoom(1.2);
      if(action==='zoom-out')this.zoom(1/1.2);
      if(action==='fit')this.fit();
      if(action==='reset') {for(const [key,p] of this.defaults)Object.assign(this.nodes.get(key),p);this.drawPositions();this.fit();}
      if(action)this.save();
    },{signal});
    this.observer = new ResizeObserver(()=>{
      this.svg.setAttribute('viewBox',`0 0 ${this.svg.clientWidth} ${this.svg.clientHeight}`);
      if(!this.sized){this.sized=true;if(this.restoreCamera)this.applyCamera();else this.fit();}
    });
    this.observer.observe(svg);
  }
  addNode(node) { this.nodes.set(node.key,node); }
  validPoint(p) {return p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<=1e7&&Math.abs(p.y)<=1e7;}
  load() {
    try{return diagramLayouts.get(this.storageKey)||JSON.parse(localStorage.getItem(this.storageKey))||{};}catch{return {};}
  }
  save() {
    const data={positions:Object.fromEntries([...this.nodes].map(([key,n])=>[key,{x:n.x,y:n.y}])),camera:{...this.camera}};
    diagramLayouts.set(this.storageKey,data);
    try{localStorage.setItem(this.storageKey,JSON.stringify(data));}catch{/* Private browsing or full storage: retain the view for this session. */}
  }
  textLines(text,limit,maxLines) {
    const words=String(text||'').split(/\s+/).filter(Boolean),lines=[];
    let line='';
    for(const word of words) {
      if((line+' '+word).trim().length<=limit)line=(line+' '+word).trim();
      else {if(line)lines.push(line);line=word;}
    }
    if(line)lines.push(line);
    const result=lines.slice(0,maxLines).map(s=>s.length>limit?s.slice(0,limit-1)+'…':s);
    if(lines.length>maxLines)result[maxLines-1]=result[maxLines-1].slice(0,limit-1)+'…';
    return result;
  }
  title(node) {
    return this.textLines(node.name,node.kind==='step'?25:23,2).map((line,i)=>`<tspan x="20" dy="${i?21:0}">${esc(line)}</tspan>`).join('');
  }
  draw() {
    this.svg.querySelector('.diagram-edges').innerHTML=this.edges.map((e,i)=>`<path data-edge-index="${i}" class="diagram-edge ${e.kind}" ${e.kind==='flow'?'marker-end="url(#flowArrow)"':''}><title>${e.kind==='flow'?'Delivery sequence':'Linked process'}: ${esc(this.nodes.get(e.from).name)} → ${esc(this.nodes.get(e.to).name)}</title></path>`).join('');
    this.svg.querySelector('.diagram-nodes').innerHTML=[...this.nodes.values()].map(n=>`<g class="diagram-node ${n.kind==='step'?'delivery-step':n.kind}" data-node-key="${n.key}" tabindex="0" role="button" aria-label="${esc(n.caption+': '+n.name+'. Drag or use arrow keys to move.'+(n.kind!=='terminal'?' Enter for details.':''))}"><title>${esc(n.name)}${n.owner?' — '+esc(n.owner):''}</title><rect class="node-shadow" x="0" y="4" width="${n.w}" height="${n.h}" rx="12"/><rect class="node-body" width="${n.w}" height="${n.h}" rx="12"/><rect class="node-accent" x="0" y="12" width="4" height="${n.h-24}" rx="2"/><text class="node-caption" x="20" y="29">${esc(n.caption)}</text><text class="node-title" x="20" y="57">${this.title(n)}</text>${n.kind==='step'?`<text class="node-owner" x="20" y="104">${esc(this.textLines(n.owner||'No owner assigned',32,1)[0])}</text><path class="node-divider" d="M20 120 H${n.w-20}"/><text class="node-timing" x="20" y="147">Work ${duration(n.work)}</text><text class="node-timing" x="140" y="147">Wait ${duration(n.wait)}</text>`:n.kind==='process'?`<text class="node-owner" x="20" y="103">${esc(this.textLines(n.owner||'No owner assigned',30,1)[0])}</text><text class="node-description" x="20" y="124">${esc(this.textLines(n.description||'Open for process details',31,1)[0])}</text>`:'<text class="node-owner" x="20" y="105">Value stream boundary</text>'}</g>`).join('');
    this.drawPositions();this.applyCamera();
  }
  drawPositions() {
    this.svg.querySelectorAll('[data-node-key]').forEach(el=>{const n=this.nodes.get(el.dataset.nodeKey);el.setAttribute('transform',`translate(${n.x} ${n.y})`);});
    this.svg.querySelectorAll('[data-edge-index]').forEach(el=>{
      const e=this.edges[Number(el.dataset.edgeIndex)],a=this.nodes.get(e.from),b=this.nodes.get(e.to);
      let x1,y1,x2,y2,c1x,c1y,c2x,c2y;
      if(e.kind==='flow') {
        const forward=b.x+b.w/2>=a.x+a.w/2;
        x1=a.x+(forward?a.w:0);y1=a.y+a.h/2;x2=b.x+(forward?0:b.w);y2=b.y+b.h/2;
        const curve=Math.max(45,Math.abs(x2-x1)/2);
        c1x=x1+(forward?curve:-curve);c1y=y1;c2x=x2+(forward?-curve:curve);c2y=y2;
      } else {
        const below=b.y+b.h/2>=a.y+a.h/2,side=a.x+a.w/2>b.x+b.w/2?1:-1;
        x1=a.x+a.w/2;y1=a.y+(below?a.h:0);x2=b.x+(side===1?b.w:0);y2=b.y+b.h/2;
        const lane=x2+side*36,bend=y1+(below?50:-50),approach=y2>=bend?1:-1;
        // Route beside stacked processes so a link never implies a process-to-process chain.
        el.setAttribute('d',`M${x1} ${y1} C${x1} ${bend} ${lane} ${bend} ${lane} ${bend+(below?20:-20)} L${lane} ${y2-approach*20} Q${lane} ${y2} ${x2} ${y2}`);
        return;
      }
      el.setAttribute('d',`M${x1} ${y1} C${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}`);
    });
  }
  point(e) {const r=this.svg.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
  world(point) {return {x:(point.x-this.camera.x)/this.camera.scale,y:(point.y-this.camera.y)/this.camera.scale};}
  applyCamera() {
    this.scene.setAttribute('transform',`translate(${this.camera.x} ${this.camera.y}) scale(${this.camera.scale})`);
    $('#diagramZoom').textContent=Math.round(this.camera.scale*100)+'%';
  }
  zoom(factor,anchor={x:this.svg.clientWidth/2,y:this.svg.clientHeight/2}) {
    const world=this.world(anchor),scale=Math.max(.02,Math.min(2.5,this.camera.scale*factor));
    this.camera={x:anchor.x-world.x*scale,y:anchor.y-world.y*scale,scale};this.applyCamera();
  }
  fit() {
    const nodes=[...this.nodes.values()],left=Math.min(...nodes.map(n=>n.x)),top=Math.min(...nodes.map(n=>n.y));
    const width=Math.max(...nodes.map(n=>n.x+n.w))-left,height=Math.max(...nodes.map(n=>n.y+n.h))-top;
    const scale=Math.max(.02,Math.min(1,(this.svg.clientWidth-64)/width,(this.svg.clientHeight-64)/height));
    this.camera={x:(this.svg.clientWidth-width*scale)/2-left*scale,y:(this.svg.clientHeight-height*scale)/2-top*scale,scale};this.applyCamera();
  }
  pointerDown(e) {
    if(e.button!==0&&e.button!==1)return;
    e.preventDefault();
    const point=this.point(e);this.pointers.set(e.pointerId,point);
    const nodeElement=e.target.closest('[data-node-key]');
    (nodeElement||this.svg).setPointerCapture(e.pointerId);
    if(this.pointers.size===2) {
      const [a,b]=[...this.pointers.values()],center={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      this.gesture={type:'pinch',distance:Math.max(1,Math.hypot(b.x-a.x,b.y-a.y)),scale:this.camera.scale,world:this.world(center)};
    } else if(this.pointers.size===1) {
      const node=e.button===0&&nodeElement?this.nodes.get(nodeElement.dataset.nodeKey):null;
      this.gesture={type:node?'node':'pan',start:point,camera:{...this.camera},node,nodeStart:node?{x:node.x,y:node.y}:null};
      (nodeElement||this.svg).focus({preventScroll:true});
    }
    this.svg.classList.add('is-dragging');
  }
  pointerMove(e) {
    if(!this.pointers.has(e.pointerId)||!this.gesture)return;
    const point=this.point(e);this.pointers.set(e.pointerId,point);
    const g=this.gesture;
    if(g.type==='pinch'&&this.pointers.size>=2) {
      const [a,b]=[...this.pointers.values()],center={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      const scale=Math.max(.02,Math.min(2.5,g.scale*Math.hypot(b.x-a.x,b.y-a.y)/g.distance));
      this.camera={x:center.x-g.world.x*scale,y:center.y-g.world.y*scale,scale};this.applyCamera();
    } else if(g.type==='node') {
      g.node.x=Math.max(-1e6,Math.min(1e6,g.nodeStart.x+(point.x-g.start.x)/this.camera.scale));
      g.node.y=Math.max(-1e6,Math.min(1e6,g.nodeStart.y+(point.y-g.start.y)/this.camera.scale));
      this.drawPositions();
    } else if(g.type==='pan') {
      this.camera.x=g.camera.x+point.x-g.start.x;this.camera.y=g.camera.y+point.y-g.start.y;this.applyCamera();
    }
  }
  pointerUp(e) {
    if(!this.pointers.has(e.pointerId))return;
    this.pointers.delete(e.pointerId);
    if(this.pointers.size===1)this.gesture={type:'pan',start:[...this.pointers.values()][0],camera:{...this.camera}};
    else {this.gesture=null;this.svg.classList.remove('is-dragging');}
    this.save();
  }
  keyDown(e) {
    const arrows={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    const key=e.target.closest('[data-node-key]')?.dataset.nodeKey,node=this.nodes.get(key);
    if(arrows[e.key]) {
      e.preventDefault();const [dx,dy]=arrows[e.key],distance=e.shiftKey?100:20;
      if(node){node.x+=dx*distance;node.y+=dy*distance;this.drawPositions();}
      else {this.camera.x-=dx*distance;this.camera.y-=dy*distance;this.applyCamera();}
      this.save();
    } else if(e.key==='+'||e.key==='='){e.preventDefault();this.zoom(1.2);this.save();}
    else if(e.key==='-'||e.key==='_'){e.preventDefault();this.zoom(1/1.2);this.save();}
    else if(e.key==='0'){e.preventDefault();this.fit();this.save();}
    else if((e.key==='Enter'||e.key===' ')&&node){e.preventDefault();this.details(node);}
  }
  details(node) {
    if(node.kind==='process')editProcess(node.id);
    if(node.kind==='step') {
      if(canEdit())editStep(node.id);
      else {const step=state.steps.find(s=>s.id===node.id);modal('Step details',field('name','Step name',step.name)+field('owner','Responsible team / owner',step.owner)+field('work_minutes','Active work time (minutes)',step.work_minutes)+field('wait_minutes','Waiting time (minutes)',step.wait_minutes),null,true);}
    }
  }
  destroy() {this.listeners.abort();this.observer.disconnect();}
}

refresh().catch(error);
