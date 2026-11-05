'use strict';
// FORUM ONLY. Closed synthetic browser replay of an already-loaded production
// shell + fresh app-owned diagnostic. No owner origin, database or native service.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const shell=process.env.QA_SHELL_SOURCE,appRoot=process.env.QA_APP_SOURCE,out=process.env.QA_OUT;
assert(shell&&appRoot&&out,'QA_SHELL_SOURCE, QA_APP_SOURCE and QA_OUT required');
process.env.QA_TREE=shell;fs.mkdirSync(out,{recursive:true});
const {chromium}=require(path.join(shell,'tools/qa-playwright.cjs'));
const fixture=require(path.join(shell,'tools/qa-closed-shell.cjs'));
const evidenceHelper=require(path.join(shell,'tools/qa-recorder-stop-evidence.cjs'));
const controller=require(path.join(shell,'tools/qa-recorder-controller.cjs'));
const recorder=fs.readFileSync(path.join(appRoot,'app.js'),'utf8');
const controllerPage=controller.fixture(recorder);
const report={synthetic:true,baseline:process.env.QA_DIAGNOSTIC_BASELINE==='1',cases:[],screenshots:[],sinks:[],secureContexts:[]};
const hash=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
report.source={capture:hash(fs.readFileSync(path.join(shell,'web/core/app-capture.js'))),recorder:hash(recorder)};
let browser,page,stage='boot';
const pass=s=>{report.cases.push(s);console.log('PASS',s)};
// Retain actual computed pairs and WCAG contrast, not an RGB-string proxy.
const contrastUI=target=>target.evaluate(()=>{
 const rgb=s=>{const c=s.match(/[\d.]+/g)?.map(Number);if(!c||c.length<3)throw Error('Unparseable computed colour');return c.length===3?[...c,1]:c};
 const lum=c=>c.slice(0,3).map(x=>{x/=255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4}).reduce((n,x,i)=>n+x*[0.2126,0.7152,0.0722][i],0);
 const pair=n=>{const s=getComputedStyle(n),ink=rgb(s.color),fill=rgb(s.backgroundColor),a=lum(ink),b=lum(fill);return {ink:s.color,fill:s.backgroundColor,inkAlpha:ink[3],fillAlpha:fill[3],opacity:Number(s.opacity),contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)}};
 const b=document.querySelector('button');return {height:b.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth,panel:pair(document.querySelector('pre')),button:pair(b)};
});
const assertContrast=ui=>{for(const role of ['panel','button']){const p=ui[role];assert.equal(p.inkAlpha,1,role+' opaque ink');assert.equal(p.fillAlpha,1,role+' opaque fill');assert.equal(p.opacity,1,role+' opacity');assert(p.contrast>=4.5,role+' contrast >=4.5: '+p.contrast)}};
(async()=>{try{
 browser=await chromium.launch({executablePath:process.env.QA_CHROME||undefined,args:['--disable-background-networking','--use-angle=swiftshader','--enable-unsafe-swiftshader']});fixture.setBrowser(browser);
 for(const phone of [true,false]){
  const mode=phone?'phone':'desktop';stage=mode+': boot';let version='a'.repeat(40);
  const sinkReport={mode,errors:[],evidenceRequests:[]};report.sinks.push(sinkReport);
  const sink=await evidenceHelper.start({out,mode,report:sinkReport});
  sinkReport.origin=evidenceHelper.origin(sink);let context;
  try{
  const {c,s}=await fixture.boot(phone,async c=>{
   context=c;
   await c.addInitScript(()=>{if(window===top)sessionStorage.setItem('syntheticLoads',String(+(sessionStorage.getItem('syntheticLoads')||0)+1));});
   await c.route('**/wizard/v1/apps',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({apps:[{id:'mizel',name:'Synthetic Recorder',kind:'wizard',url:'/mizel-live/',source:'apps.json'}]})}));
   await c.route('**/wizard-os-home/ux-version.txt',r=>r.fulfill({contentType:'text/plain',body:version}));
   await c.route('**/mizel-live/**',r=>{
    const u=new URL(r.request().url()),name=u.pathname.slice('/mizel-live/'.length);
    if(!name||name==='index.html')return r.fulfill({contentType:'text/html',body:controllerPage});
    if(['reload-check.html','reload-check.js','reload-check.css','wizard-style.css'].includes(name)){
     if(report.baseline&&name.startsWith('reload-check'))return r.fulfill({status:404,body:'Diagnostic absent in baseline'});
     return r.fulfill({path:path.join(appRoot,name)});
    }
    throw Error('Unadmitted app route '+u.pathname);
   });
  },sink);
  page=fixture.getPage();
  page.on('response',r=>{const u=new URL(r.url());if(u.pathname==='/mizel-live/reload-check.html')(report.diagnosticResponses??=[]).push({mode,path:u.pathname,status:r.status()});});
  const secure=await page.evaluate(()=>({origin:location.origin,isSecureContext,webLocks:typeof navigator.locks?.request==='function'}));
  report.secureContexts.push({mode,...secure});
  assert.equal(secure.origin,evidenceHelper.origin(sink));assert.equal(secure.isSecureContext,true);assert.equal(secure.webLocks,true);
  pass(mode+': owned loopback is secure with real Web Locks');
  await page.clock.resume();await page.evaluate(()=>WizOpenApp('mizel'));
  await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].some(f=>f.contentWindow?.fixtureReady));
  const original=page.frames().find(f=>new URL(f.url()).pathname==='/mizel-live/');assert(original);
  assert.equal(await original.evaluate(()=>window.fixtureError||null),null);
  await page.waitForFunction(()=>WizAppCapture.getState().nativeRegistryReady===true);
  const before=await page.evaluate(()=>{window.syntheticCaptureRef=WizAppCapture;window.syntheticOriginalFrame=[...document.querySelectorAll('iframe')].find(f=>f.contentWindow?.fixtureReady);window.syntheticOriginalState=syntheticOriginalFrame.contentWindow.fixtureState;return sessionStorage.getItem('syntheticLoads')});
  stage=mode+': exact immediate failure';
  await page.evaluate(()=>WizWebUpdate.check(true));version='b'.repeat(40);await page.evaluate(()=>WizWebUpdate.check(true));
  await page.evaluate(()=>{
   WizAppCapture.configureNativeBridge({start(){throw Error('Synthetic native start forbidden')},stop(){throw Error('Synthetic native stop forbidden')},status:async()=>null});
   window.syntheticTapAt=performance.now();WizWebUpdate.reload('tap');
  });
  await page.waitForFunction(()=>WizAppCapture.getState().error==='native_owner_uncertain'&&!document.querySelector('#dvWeb [aria-busy="true"]'));
  const failed=await page.evaluate(()=>({elapsed:performance.now()-syntheticTapAt,armed:WizWebUpdate.armed,text:document.querySelector('#toast')?.textContent||'',safe:WizAppCapture.reloadCheck().safe}));
  assert(failed.elapsed<3000,'must be immediate branch, not 15s timeout');assert.equal(failed.armed,false);assert.equal(failed.safe,false);assert.match(failed.text,/check the recorder/);pass(mode+': served guard immediately refuses unknown native truth');
  stage=mode+': existing Chats link creates fresh view';
  s.rows[0].preview='[Recorder reload check](/mizel-live/reload-check.html?check=local-v1)';s.rows[0].latest_message.content=s.rows[0].preview;
  await page.evaluate(()=>WizCore.deeplink.route(location.origin+'/wizard-os-home/?session=badge-read-ready'));
  const link=page.getByRole('link',{name:'Recorder reload check',exact:true}).first();await link.waitFor();await link.click();
  // Find the real navigated frame, not the iframe's initial src attribute. The
  // desktop shared link path may navigate contentWindow without rewriting src.
  const diagnostic=()=>page.frames().find(f=>{try{return new URL(f.url()).pathname==='/mizel-live/reload-check.html'}catch{return false}});
  const deadline=Date.now()+8000;
  while(!diagnostic()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,40));
  assert(diagnostic(),'REGRESSION_FRESH_DIAGNOSTIC_UNAVAILABLE_ON_OLD_SHELL');
  await diagnostic().locator('[data-reload-check-result]').waitFor({state:'visible',timeout:8000});
  await diagnostic().waitForFunction(()=>document.querySelector('[data-reload-check-result]')?.textContent.includes('native_owner_uncertain'),null,{timeout:8000});
  const text=await diagnostic().locator('[data-reload-check-result]').textContent();assert.match(text,/Reason: capture_custody_uncertain/);assert.match(text,/Code: native_owner_uncertain/);assert(!text.includes('synthetic-meeting'));pass(mode+': fresh diagnostic executes against already-loaded host');
  const unchanged=await page.evaluate(()=>({loads:sessionStorage.getItem('syntheticLoads'),sameCapture:WizAppCapture===syntheticCaptureRef,sameFrame:syntheticOriginalFrame.isConnected&&syntheticOriginalFrame.contentWindow.fixtureState===syntheticOriginalState,safe:WizAppCapture.reloadCheck().safe,armed:WizWebUpdate.armed}));
  assert.deepEqual(unchanged,{loads:before,sameCapture:true,sameFrame:true,safe:false,armed:false});assert(!original.isDetached());pass(mode+': original Recorder frame and root stay alive, custody still blocked');
  // Dismiss the real one-off review coach; do not remove or hide product UI.
  const coach=page.getByRole('dialog',{name:'Review mode',exact:true});
  if(await coach.isVisible()){await coach.getByRole('button',{name:'Got it',exact:true}).click();await coach.waitFor({state:'detached'});}
  for(const skin of ['nebula','sepia']){
   stage=mode+': '+skin+' appearance';await page.evaluate(s=>WosSkin.set(s),skin);await fixture.settle(page);
   const frame=diagnostic();await frame.waitForFunction(s=>document.documentElement.hasAttribute('data-wz-hosted')&&document.documentElement.dataset.skin===s,skin);
   await frame.evaluate(()=>document.fonts.ready);await fixture.settle(frame);
   const ui=await contrastUI(frame);
   assert(ui.height>=48);assert(!ui.overflow);assertContrast(ui);
   const file=path.join(out,mode+'-'+skin+'-reload-check.png');await page.screenshot({path:file});report.screenshots.push({file,mode,skin,...ui});
   await frame.locator('button').click();assert.match(await frame.locator('pre').textContent(),/native_owner_uncertain/);
  }
  pass(mode+': live two-skin appearance and repeat read');
  stage=mode+': standalone dark fallback';const standalone=await c.newPage();await standalone.goto(new URL('/mizel-live/reload-check.html',page.url()).href);
  await standalone.waitForFunction(()=>document.querySelector('pre')?.textContent.includes('shell_unavailable'));
  await standalone.evaluate(()=>document.fonts.ready);await fixture.settle(standalone);
  const fallbackUI=await contrastUI(standalone);assertContrast(fallbackUI);
  const fallback=path.join(out,mode+'-standalone-dark.png');await standalone.screenshot({path:fallback});report.screenshots.push({file:fallback,mode,skin:'standalone-dark',...fallbackUI});await standalone.close();
  pass(mode+': standalone refuses a fabricated host reading');
  }catch(e){
   const current=fixture.getPage();
   report.syntheticFrames=await Promise.all((current?.frames()||[]).map(async f=>({url:f.url(),parentUrl:f.parentFrame()?.url()||null,...await f.evaluate(()=>({hasCapture:typeof window.WizAppCapture?.reloadCheck==='function',result:location.pathname==='/mizel-live/reload-check.html'?document.querySelector('[data-reload-check-result]')?.textContent||null:null})).catch(()=>({unreadable:true}))})));
   report.syntheticFailureState=await current?.evaluate(()=>({origin:location.origin,isSecureContext,webLocks:typeof navigator.locks?.request==='function',nativeRegistryReady:window.WizAppCapture?.getState().nativeRegistryReady,error:window.WizAppCapture?.getState().error})).catch(()=>null);
   await current?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw e;
  }finally{
   try{await context?.close();}finally{await sink.close();}
   assert.deepEqual(sinkReport.errors,[],'owned evidence sink errors');
  }
 }
 assert.deepEqual(fixture.report.unknown,[]);assert.deepEqual(fixture.report.errors,[]);assert.deepEqual(fixture.report.refusedWrites,[]);pass('closed synthetic network fence');
}catch(e){report.failure={stage,error:String(e.stack)};process.exitCode=1;console.error(report.failure);await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}finally{fs.writeFileSync(path.join(out,'reload-check-browser.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(out,'fixture-requests.json'),JSON.stringify(fixture.report,null,2));await browser?.close();}})();
