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
  await page.getByLabel('Username',{exact:true}).fill('brand-admin');await page.getByLabel('Password',{exact:true}).fill('branding-password-123');
  await page.getByRole('button',{name:'Create Admin account'}).click();
  if (await page.locator('#adminToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#adminToggle').click();
  await page.locator('#brandingNav').click();await page.getByRole('heading',{name:'Branding & theme'}).waitFor();
  await page.screenshot({path:'/tmp/vsm-branding-default.png',fullPage:true});
  await page.getByLabel('Application name',{exact:true}).fill('Service Hub');
  await page.getByLabel('Workspace tagline').fill('Our local services');
  await page.locator('[name=primary]').fill('#0066cc');
  await page.locator('#brandLogoFile').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
  await page.getByRole('button',{name:'Save branding',exact:true}).click();await page.getByText('Branding saved.',{exact:true}).waitFor();
  assert.equal(await page.title(),'Service Hub');assert.equal(await page.locator('.brand span').textContent(),'Service Hub');
  await page.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()==='#0066cc');
  assert.equal(await page.locator('.brand-logo').count(),1);
  await page.reload();await page.getByRole('heading',{name:'Value streams',exact:true}).waitFor();assert.equal(await page.title(),'Service Hub');
  await page.getByRole('button',{name:'Sign out'}).click();await page.getByRole('heading',{name:'Welcome back'}).waitFor();assert.equal(await page.title(),'Service Hub');
  assert.equal(await page.locator('#adminMenu').isVisible(),false);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:1440,height:1000});
  await page.getByLabel('Username',{exact:true}).fill('brand-admin');await page.getByLabel('Password',{exact:true}).fill('branding-password-123');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  if (await page.locator('#adminToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#adminToggle').click();
  await page.locator('#brandingNav').click();page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Restore default theme'}).click();await page.getByText('Branding saved.',{exact:true}).waitFor();
  assert.equal(await page.title(),'VSM Toolbox');assert.equal(await page.locator('.brand-logo').count(),0);
  assert.deepEqual(errors,[]);console.log('Branding browser test passed: save, logo, dynamic CSS, persistence, sign-in branding, mobile layout.');
 }finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
