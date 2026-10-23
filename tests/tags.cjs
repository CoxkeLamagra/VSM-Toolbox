const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'vsm-branding-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base=`http://127.0.0.1:${port}`;
 const server=spawn(process.env.PYTHON||'python3',['app.py'],{env:{...process.env,VSM_HOST:'127.0.0.1',VSM_PORT:String(port),VSM_DATABASE:path.join(temp,'workspace.sqlite3')},stdio:'ignore'});
 let browser;
 try{
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({executablePath:process.env.VSM_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  await page.getByLabel('Username',{exact:true}).fill('tag-admin');await page.getByLabel('Password',{exact:true}).fill('tag-password-123');
  await page.getByRole('button',{name:'Create Admin account'}).click();
  const save=()=>page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.locator('#tagsNav').click();
  await page.getByRole('button',{name:'Create category'}).click();await page.getByLabel('Category name').fill('Service type');await save();
  await page.getByRole('button',{name:'Create tag',exact:false}).click();await page.getByLabel('Tag name').fill('Critical');await page.getByLabel('Tag color').fill('#336699');await page.getByLabel('Category',{exact:true}).selectOption({label:'Service type'});await save();
  await page.getByRole('heading',{name:'Service type',exact:true}).waitFor();
  await page.locator('#streamsNav').click();await page.getByRole('button',{name:'Create value stream',exact:false}).click();
  await page.getByLabel('Stream name').fill('Tagged service');await page.getByRole('checkbox',{name:'Critical',exact:true}).check();await save();
  await page.getByRole('heading',{name:'Tagged service',exact:true}).waitFor();assert.ok(await page.locator('.title-row .tag-badge').count());
  await page.locator('[data-action=new-step]').first().click();await page.getByLabel('Step name').fill('Triage');await page.getByRole('checkbox',{name:'Critical',exact:true}).check();await save();
  await page.locator('#streamDiagram .svg-tag-text').waitFor();assert.equal(await page.locator('#streamDiagram .svg-tag-text').textContent(),'Critical');
  await page.getByRole('button',{name:'Edit flow',exact:true}).click();assert.equal(await page.locator('.step .tag-badge').textContent(),'Critical');
  await page.locator('#processNav').click();await page.getByRole('button',{name:'Create process'}).click();await page.getByLabel('Process name').fill('Incident management');await page.getByRole('checkbox',{name:'Critical',exact:true}).check();await save();
  assert.equal(await page.locator('.process-card .tag-badge').textContent(),'Critical');
  await page.locator('#streamsNav').click();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.tagged-icon')).backgroundColor==='rgb(51, 102, 153)');
  await page.locator('#tagsNav').click();await page.locator('[data-action=edit-tag]').click();await page.getByLabel('Tag color').fill('#ffcc00');await save();
  await page.locator('#streamsNav').click();await page.waitForFunction(()=>getComputedStyle(document.querySelector('.tagged-icon')).backgroundColor==='rgb(255, 204, 0)');
  await page.screenshot({path:'/tmp/vsm-tags-overview.png',fullPage:true});
  await page.locator('#tagsNav').click();page.once('dialog',d=>d.accept());await page.locator('[data-action=delete-category]').click();
  await page.getByRole('heading',{name:'Service type',exact:true}).waitFor({state:'detached'});assert.equal(await page.locator('.tag-management .tag-badge').textContent(),'Critical');
  // Editors can assign existing tags, but cannot administer the shared catalog.
  await page.evaluate(async()=>{const session=await(await fetch('/api/session')).json();await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf_token},body:JSON.stringify({username:'tag-editor',password:'tag-password-123',role:'Editor'})});});
  await page.getByRole('button',{name:'Sign out'}).click();await page.getByLabel('Username',{exact:true}).fill('tag-editor');await page.getByLabel('Password',{exact:true}).fill('tag-password-123');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:'Value streams',exact:true}).waitFor();assert.equal(await page.locator('#tagsNav').isVisible(),false);
  await page.locator('.stream-card h3').click();await page.getByRole('button',{name:'Edit details',exact:true}).click();await page.getByRole('checkbox',{name:'Critical',exact:true}).uncheck();await save();await page.locator('#streamsNav').click();assert.equal(await page.locator('.tagged-icon').count(),0);
  assert.deepEqual(errors,[]);console.log('Tag browser test passed: category/tag management, all three assignment forms, diagram/flow badges, icon colors, color edits, category deletion, and Editor access.');
 }finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
