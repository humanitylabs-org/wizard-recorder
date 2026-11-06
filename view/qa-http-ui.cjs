// Actual adopted HTTP server and UI, synthetic upstreams only; never visits live services.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process'),assert=require('node:assert/strict'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=process.env.UI_EVIDENCE;if(!dir?.startsWith('/Volumes/ThalesMedia/')||!os.hostname().startsWith('thales'))throw Error('Thales external QA required');fs.mkdirSync(dir,{recursive:true});
const {DatabaseSync}=require('node:sqlite');
const queueFile=path.join(dir,'synthetic-queue.sqlite3');fs.rmSync(queueFile,{force:true});const queue=new DatabaseSync(queueFile);
queue.exec('CREATE TABLE wizard_run_queue(public_run_id TEXT,session_id TEXT,idempotency_key TEXT,runtime TEXT,body TEXT)');
queue.prepare('INSERT INTO wizard_run_queue VALUES(?,?,?,?,?)').run('run-synthetic','thread-synthetic','delivery-synthetic-ui','direct',JSON.stringify({session_id:'thread-synthetic'}));queue.close();
const checks=[],requests=[],errors=[];let child,browser,answerReady=false;
const meeting={id:'synthetic-ui',source:'meetings',title:'Synthetic meeting',status:'done',started_at:'2026-01-01T00:00:00Z',duration_ms:10000,notes:'',notes_rev:0,chunks:[],segments:[{id:'seg-a',start_ms:0,end_ms:1000,text:'Synthetic A',source:'me'},{id:'seg-c',start_ms:2000,end_ms:3000,text:'Synthetic C',source:'me'}],enhanced:{markdown:'# Frozen meeting summary\n\nOnly meeting speech.',created_at:'2026-01-01T00:00:00Z'},jobs:{}};
const fixture=http.createServer((req,res)=>{requests.push({method:req.method,path:req.url});res.setHeader('Content-Type','application/json');
 if(req.url.includes('/v1/runs/run-synthetic'))return res.end(JSON.stringify({run_id:'run-synthetic',session_id:'thread-synthetic',status:answerReady?'completed':'running',output:answerReady?'Synthetic later answer, not an agreed decision':''}));
 if(req.url.includes('/messages'))return res.end(JSON.stringify({data:[{id:42,role:'user',content:'Synthetic question\n\n[WIZARD_FILES_V1]\n[{"id":"file-synthetic"}]\n[/WIZARD_FILES_V1]'}],pagination:{has_more:false}}));
 if(req.url.includes('/export.md')){res.setHeader('Content-Type','text/markdown');return res.end('# Frozen meeting summary\n\nOnly meeting speech.');}
 if(req.url.includes('/segments'))return res.end(JSON.stringify({segments:meeting.segments,pending:0}));
 if(req.url.includes('/meetings/synthetic-ui'))return res.end(JSON.stringify(meeting));
 if(req.url.includes('/calendar'))return res.end(JSON.stringify({events:[]}));
 if(req.url.includes('/meetings'))return res.end(JSON.stringify({meetings:[meeting]}));
 res.end('{}');
});
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));let base,port;
async function test(name,fn){await fn();checks.push({name,passed:true});console.log('PASS',name);}
async function start(){child=cp.spawn(process.execPath,[path.join(__dirname,'server.mjs')],{env:{...process.env,HOME:path.join(dir,'home'),MIZEL_LIVE_DATA:path.join(dir,'data'),WIZARD_ORB_QUEUE_DB:queueFile,MIZEL_LIVE_PORT:String(port),MEETINGS_PORT:String(fixture.address().port),WIZARD_API_URL:'http://127.0.0.1:'+fixture.address().port,WIZARD_ORB_API_URL:'http://127.0.0.1:'+fixture.address().port,RECORDER_ORB_EVENTS:'1',WIZARD_API_TOKEN:'synthetic-key',WIZARD_ROUTER_URL:'http://127.0.0.1:'+fixture.address().port,WIZARD_ROUTER_GRANT:'synthetic-grant',MIZEL_ALLOWED_ORIGINS:base},stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>fs.appendFileSync(path.join(dir,'server.log'),d));child.stderr.on('data',d=>fs.appendFileSync(path.join(dir,'server.log'),d));for(let i=0;i<100;i++){try{if((await fetch(base+'/live-health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Isolated server failed to become ready');}
async function stop(){if(child&&!child.killed&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}
const event={id:'orb-synthetic-ui',meetingId:meeting.id,captureId:'capture-synthetic-ui',atMediaMs:1500.5,status:'sent',clientRevision:1,voiceTakeId:'voice-synthetic-ui',deliveryKey:'delivery-synthetic-ui',threadId:'thread-synthetic',runId:'run-synthetic',audioFileId:'file-synthetic',question:'Synthetic question'};
async function put(value=event,origin=base){return fetch(base+'/orb-events',{method:'PUT',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(value)});}
async function rows(){return (await (await fetch(base+'/orb-events?meetingId='+meeting.id)).json()).events;}
(async()=>{await listen(fixture);const reserve=http.createServer();await listen(reserve);port=reserve.address().port;await new Promise(r=>reserve.close(r));base='http://127.0.0.1:'+port;await start();
 await test('HTTP same-origin event admission, exact replay, conflict rejection and origin denial',async()=>{assert.equal((await put()).status,200);assert.equal((await put()).status,200);assert.equal((await rows()).length,1);assert.equal((await put({...event,clientRevision:2,runId:'wrong'})).status,409);assert.equal((await put(event,'https://wrong.invalid')).status,403);});
 await test('server restart retains link, polls exact existing run and numeric user message, performs no send',async()=>{await stop();answerReady=true;await start();let r;for(let i=0;i<90;i++){r=(await rows())[0];if(r.status==='answered'&&r.userMessageId===42)break;await new Promise(r=>setTimeout(r,100));}assert.equal(r.status,'answered');assert.equal(r.userMessageId,42);assert.equal(r.answer,'Synthetic later answer, not an agreed decision');assert.ok(requests.length);assert.equal(requests.filter(r=>r.method!=='GET').length,0);});
 await test('export includes deterministic linked discussion without modifying frozen summary',async()=>{const a=await (await fetch(base+'/api/meetings/synthetic-ui/export.md')).text(),b=await (await fetch(base+'/api/meetings/synthetic-ui/export.md')).text();assert.equal(a,b);assert.ok(a.startsWith('# Frozen meeting summary\n\nOnly meeting speech.'));assert.match(a,/Assistant discussions/);assert.match(a,/Synthetic later answer/);assert.match(a,/session=thread-synthetic/);});
 browser=await chromium.launch({executablePath:process.env.CHROMIUM,headless:true});const context=await browser.newContext({viewport:{width:412,height:892}}),p=await context.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));
 await context.route('**/wizard-os-home/core/**',r=>{const file=path.join(process.env.UX_WEB,'core',new URL(r.request().url()).pathname.split('/').pop());return r.fulfill({contentType:'text/javascript',body:fs.readFileSync(file)});});
 await test('actual adopted UI opens transcript with chronological linked event and later answer',async()=>{
   await p.goto(base+'/wizard-recorder/#/m/synthetic-ui');await p.waitForTimeout(4000);
   // Use existing controls and route, not a replacement UI or injection into its renderer.
   const text=await p.locator('body').innerText();fs.writeFileSync(path.join(dir,'initial-body.txt'),text);
   const tab=p.getByRole('tab',{name:'Transcript',exact:true});await tab.click();
   await p.locator('#segments [data-orb-event="orb-synthetic-ui"]').first().waitFor({timeout:8000});
   assert.ok((await p.locator('body').innerText()).includes('Synthetic question'));
   const link=p.locator('#segments [data-orb-event] a').first();assert.equal(await link.getAttribute('href'),'/wizard/?session=thread-synthetic');
   const dom=await p.locator('#segments').textContent();assert.ok(dom.indexOf('Synthetic A')<dom.indexOf('Synthetic question'));assert.ok(dom.indexOf('Synthetic question')<dom.indexOf('Synthetic C'));
   await p.locator('#segments [data-orb-event] summary').first().click();assert.ok((await p.locator('body').innerText()).includes('Synthetic later answer'));
   await p.screenshot({path:path.join(dir,'transcript.png')});
 });
 await test('summary keeps its original text and shows the same linked later answer',async()=>{await p.getByRole('tab',{name:'Summary',exact:true}).click();const summary=p.locator('#enhanced');assert.match(await summary.innerText(),/Frozen meeting summary/i);assert.match(await summary.innerText(),/Assistant discussions/);await summary.locator('[data-orb-event] summary').click();assert.match(await summary.innerText(),/Synthetic later answer/);await p.screenshot({path:path.join(dir,'summary.png')});});
 await test('deleting meeting removes only its event projection, never its Wizard thread',async()=>{assert.equal((await fetch(base+'/api/meetings/synthetic-ui',{method:'DELETE',headers:{Origin:base}})).status,200);assert.deepEqual(await rows(),[]);assert.equal(requests.filter(r=>r.method==='DELETE').length,1);assert.ok(requests.filter(r=>r.method==='DELETE')[0].path.endsWith('/api/meetings/synthetic-ui'));});
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify({checks,errors,requests,synthetic:true,sourceSHA:process.env.SOURCE_SHA},null,2));
})().catch(e=>{console.error(e);fs.writeFileSync(path.join(dir,'failure.json'),JSON.stringify({error:e.stack,checks,errors},null,2));process.exitCode=1;}).finally(async()=>{await browser?.close();await stop();fixture.close();});
