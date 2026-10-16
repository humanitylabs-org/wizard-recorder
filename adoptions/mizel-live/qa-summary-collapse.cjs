// Synthetic-only, bounded UI regression. Execute browser QA on the configured worker.
const {chromium}=require(process.env.MIZEL_PLAYWRIGHT || 'playwright');
const {createServer}=require('node:http');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=process.env.QA_SOURCE || path.join(__dirname,'web');
const out=process.env.QA_OUT || path.join(__dirname,'qa-summary-evidence');fs.mkdirSync(out,{recursive:true});
const watchdog=setTimeout(()=>{console.error('Summary QA exceeded 55 seconds');process.exit(2)},55000);
const meeting={id:'qa-summary',source:'meetings',title:'Summary interaction fixture',status:'recording',started_at:'2026-10-16T11:00:00Z',duration_ms:180000,notes_md:'',notes_rev:0,segments:[],audio:{tracks:[]},jobs:{enhance:'idle',transcribe_pending:0},enhanced:null};
const topic=(i)=>({id:`topic-${i}`,title:`Topic ${i}`,startMs:i*30000,active:true,bullets:[{text:`Synthetic point ${i}`,atMs:i*30000}]});
let topics=[topic(0),topic(1),topic(2)],requests=[];
const stub=`window.WizardApp={ready(){},back:{useHistory(){},register(){}},update:{hold(){return {release(){}}}},voice:{},capture:{capabilities(){return {systemAudioStart:false}},subscribe(){return ()=>{}},current(){return null},async pending(){return []},async recover(){return []}}};`;
const instrument='\nwindow.qa={state,els,summaryStore,summaryExpansion,renderSummary,renderOriginalSummary,setDocMode,setCurrent,renderDoc};';
const server=createServer((req,res)=>{const p=new URL(req.url,'http://localhost').pathname;requests.push({method:req.method,path:p});const json=o=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(o))};
 if(p.endsWith('app-client.js')){res.setHeader('Content-Type','text/javascript');return res.end(stub)}
 if(p.endsWith('app-capture.js'))return res.end('');
 if(p==='/summary')return json({summary:{topics}});
 if(p==='/orb-events')return json({events:[]});
 if(p==='/asks')return json({asks:[]});
 if(p.startsWith('/api/')){if(p==='/api/meetings')return json({meetings:[meeting]});if(p==='/api/meetings/qa-summary')return json(meeting);return json({meetings:[],events:[],asks:[],segments:[],pending:0})}
 const name=p==='/'?'index.html':p.slice(1);if(name.includes('..')){res.statusCode=400;return res.end()}
 try{let b=fs.readFileSync(path.join(root,name));if(name==='app.js')b=Buffer.from(b.toString()+instrument);res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html');res.end(b)}catch{res.statusCode=404;res.end()}
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,executablePath:process.env.MIZEL_CHROME});const results=[],errors=[];try{
 for(const config of [{width:360,height:800,colorScheme:'dark',isMobile:true,hasTouch:true},{width:1280,height:900,colorScheme:'light'}]){
  topics=[topic(0),topic(1),topic(2)];const ctx=await browser.newContext({viewport:{width:config.width,height:config.height},colorScheme:config.colorScheme,isMobile:!!config.isMobile,hasTouch:!!config.hasTouch});const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(`http://127.0.0.1:${server.address().port}/#/m/qa-summary`);await p.waitForFunction(()=>window.qa?.state.current?.id==='qa-summary');
  const seed=async()=>{await p.evaluate(sm=>{qa.summaryStore.set('qa-summary',sm);qa.setDocMode('live-summary')},{topics});await p.waitForFunction(()=>!qa.summaryStore.loading.has('qa-summary'))};await seed();
  const states=()=>p.locator('#summary .sum-toggle').evaluateAll(es=>es.map(e=>e.getAttribute('aria-expanded')==='true'));
  const check=async(name,want)=>{assert.deepEqual(await states(),want,name);const visible=await p.locator('#summary .sum-topic > ul').evaluateAll(es=>es.map(e=>getComputedStyle(e).display!=='none'));assert.deepEqual(visible,want,'actual visibility '+name);results.push(`${config.width}: ${name}`)};
  await check('only latest initially open',[false,false,true]);
  await p.locator('#summary .sum-toggle').first().click();await check('manual older opening',[true,false,true]);
  topics[0].title='Renamed existing topic';topics[2].bullets.push({text:'New point, same topic',atMs:61000});await seed();await check('stable identity through updates',[true,false,true]);
  assert.equal(await p.evaluate(()=>document.activeElement.dataset.summaryFocus),'topic-0');results.push(`${config.width}: focus survives refresh`);
  topics.push(topic(3),topic(4));await seed();await check('batched new topics collapsed except newest; manual open preserved',[true,false,false,false,true]);
  await p.locator('#summary .sum-toggle').last().click();await seed();await check('explicit newest close survives refresh',[true,false,false,false,false]);
  await p.getByRole('button',{name:'Collapse all',exact:true}).click();await seed();await check('collapse all survives update',[false,false,false,false,false]);
  topics.push(topic(5));await seed();await check('only new topic reopens after collapse all',[false,false,false,false,false,true]);
  await p.locator('#summary .sum-toggle').nth(1).focus();await p.keyboard.press('Enter');await check('keyboard toggle',[false,true,false,false,false,true]);
  await p.evaluate(()=>{qa.setDocMode('notes');qa.setDocMode('live-summary')});await check('tab return preserves choices',[false,true,false,false,false,true]);
  await p.reload();await p.waitForFunction(()=>window.qa?.state.current?.id==='qa-summary');await seed();await check('reload preserves choices in this session',[false,true,false,false,false,true]);
  await p.evaluate(()=>{const original=qa.state.current;qa.state.current={...original,id:'qa-other'};qa.summaryStore.set('qa-other',{topics:[{id:'topic-0',title:'Other meeting',bullets:[{text:'Other',atMs:0}]}]});qa.renderSummary()});assert.deepEqual(await states(),[true]);results.push(`${config.width}: meeting isolation`);
  await p.evaluate(()=>{qa.state.current.id='qa-summary'});await seed();
  const archived=await p.evaluate(()=>{const sm=qa.summaryStore.get('qa-summary');qa.state.current.status='ready';sm.originalLiveSummary=JSON.parse(JSON.stringify({topics:sm.topics}));qa.renderOriginalSummary();return [...qa.els.originalSummaryBody.querySelectorAll('.sum-toggle')].map(e=>e.getAttribute('aria-expanded')==='true')});assert.deepEqual(archived,[false,false,false,false,false,true]);results.push(`${config.width}: archived choices isolated`);
  await p.evaluate(()=>{qa.state.current.status='recording';qa.renderOriginalSummary()});
  const layout=await p.locator('#summary .sum-toggle').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {height:r.height,right:r.right,left:r.left}}));assert(layout.every(r=>r.height>=44&&r.left>=0&&r.right<=config.width));results.push(`${config.width}: 44px tap targets and width`);
  await p.screenshot({path:path.join(out,`summary-${config.width}.png`)});
  await p.getByRole('button',{name:'Collapse all',exact:true}).click();await p.reload();await p.waitForFunction(()=>window.qa?.state.current?.id==='qa-summary');await seed();await check('collapse all survives reload',[false,false,false,false,false,false]);
  topics=[];await seed();assert.equal(await p.locator('#summary .sum-controls').count(),0);assert.equal(await p.locator('#summary .sum-empty').count(),1);results.push(`${config.width}: empty summary`);
  await ctx.close();
 }
 assert.deepEqual(errors,[]);assert(requests.every(r=>r.method==='GET'),'no writes');const hashes=Object.fromEntries(['app.js','styles.css'].map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));const receipt={ok:true,host:require('node:os').hostname(),synthetic:true,checks:results.length,results,hashes,errors,writes:0};fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{await browser.close();server.close();clearTimeout(watchdog)}})().catch(e=>{console.error(e);process.exitCode=1});
