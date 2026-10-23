// Browser integration test: isolated supervisor, database, backup storage and uploaded files.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'vsm-backups-ui-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base=`http://127.0.0.1:${port}`;
 const server=spawn(process.env.PYTHON||'python3',['updater.py'],{cwd:root,env:{...process.env,VSM_HOST:'127.0.0.1',VSM_PORT:String(port),VSM_DATABASE:path.join(temp,'workspace.sqlite3'),VSM_UPDATE_DIR:path.join(temp,'updates')},stdio:['ignore','ignore','pipe']});
 let logs='',browser,cookie='',csrf='';server.stderr.on('data',d=>logs+=d);
 try{
  let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(base+'/api/health')).ok;if(ready)break;}catch{}await delay(100);}assert.ok(ready,logs);
  async function api(route,data,method=data===undefined?'GET':'POST'){
   const response=await fetch(base+'/api/'+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:data===undefined?undefined:JSON.stringify(data)});
   const result=await response.json();assert.ok(response.ok,JSON.stringify(result));
   if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];if(result.csrf_token)csrf=result.csrf_token;return result;
  }
  await api('auth/register',{username:'backup-admin',password:'backup-browser-password-123'});
  const stream=await api('streams',{name:'Original service'});
  await api('users',{username:'backup-viewer',password:'backup-viewer-password-123',role:'Viewer'});
  browser=await chromium.launch({headless:true,executablePath:process.env.VSM_CHROMIUM||undefined,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1500,height:1050},acceptDownloads:true});
  await context.addCookies([{name:'vsm_session',value:cookie.split('=')[1],url:base,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(base);await page.locator('#backupsNav').click();await page.getByRole('heading',{name:'Backups & restore',exact:true}).waitFor();
  await page.getByRole('button',{name:'Create manual backup',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Application and database backup created.'}).waitFor({timeout:30000});
  const row=page.getByRole('row').filter({hasText:'manual'}).first();await row.waitFor();
  const downloadEvent=page.waitForEvent('download');await row.getByRole('link',{name:'Download'}).click();const download=await downloadEvent;
  const id=download.suggestedFilename(),file=path.join(temp,id);await download.saveAs(file);assert.ok(fs.statSync(file).size>1000);
  await api('streams/'+stream.id,{name:'Changed after backup'},'PUT');
  await row.getByRole('button',{name:'Restore',exact:true}).click();
  async function signInAfterRestore(){
   await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor({timeout:30000});
   await page.locator('#authForm').getByLabel('Username',{exact:true}).fill('backup-admin');
   await page.locator('#authForm').getByLabel('Password',{exact:true}).fill('backup-browser-password-123');
   await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Backups & restore',exact:true}).waitFor();
  }
  await signInAfterRestore();
  assert.equal(await page.evaluate(async()=>{const r=await fetch('/api/data');return(await r.json()).streams[0].name;}),'Original service');
  await page.locator('#backupUpload').setInputFiles(file);await page.getByRole('button',{name:'Upload and restore',exact:true}).click();
  await signInAfterRestore();
  assert.equal(await page.evaluate(async()=>{const r=await fetch('/api/data');return(await r.json()).streams[0].name;}),'Original service');
  await page.locator(`input[name="backup-select"][value="${id}"]`).check();await page.getByRole('button',{name:'Delete selected backups',exact:true}).click();
  await page.locator(`input[name="backup-select"][value="${id}"]`).waitFor({state:'detached',timeout:30000});
  assert.ok(await page.getByRole('row').filter({hasText:'pre-restore'}).count()>0,'Safety backups must remain');
  await page.locator('#backupUpload').setInputFiles({name:'invalid.zip',mimeType:'application/zip',buffer:Buffer.from('not a backup')});
  await page.getByRole('button',{name:'Upload and restore',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Invalid backup upload'}).waitFor();
  assert.equal(await page.evaluate(async()=>{const r=await fetch('/api/data');return(await r.json()).streams[0].name;}),'Original service');
  cookie='';csrf='';await api('auth/login',{username:'backup-viewer',password:'backup-viewer-password-123'});await context.clearCookies();
  await context.addCookies([{name:'vsm_session',value:cookie.split('=')[1],url:base,httpOnly:true,sameSite:'Strict'}]);await page.reload();await page.getByRole('heading',{name:'Value streams',exact:true}).waitFor();
  assert.ok(!await page.locator('#backupsNav').isVisible());assert.equal(await page.evaluate(async()=>(await fetch('/api/backups')).status),403);
  assert.deepEqual(errors,[]);console.log('Backup browser test passed: create, download, local restore, uploaded restore, safety snapshots, selective cleanup, invalid upload rejection, restored accounts and Viewer restrictions.');
 }finally{
  if(browser)await browser.close();server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
