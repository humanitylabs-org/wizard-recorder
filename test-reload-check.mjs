import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {readReloadCheck,showReloadCheck} from './adoptions/mizel-live/web/reload-check.js';
const appRoot = new URL('./adoptions/mizel-live/web/', import.meta.url);
const source = readFileSync(process.env.QA_REVIEW_CAPTURE || new URL('./test-fixtures/reload-check-source.txt',import.meta.url),'utf8');
const from = source.indexOf('  function reloadCheck()'), to = source.indexOf('  // Reload may re-probe',from);
assert(from > 0 && to > from, 'actual served reload predicate source markers');
function actualCheck({owned=[],recoveryError=null,unknownMeetingActive=false,device='null',active=null,preparations=[]}={}) {
  const ctx={attachedMeetingBridge:null,ownershipLoaded:true,recoveryError,unknownMeetingActive,active,ownedRows:new Map(owned.map((r,i)=>[i,r])),recoveryLive:new Set(),preparations:new Map(preparations),W:{WizardOSDevice:{recActive:()=>device}}};
  vm.runInNewContext(source.slice(from,to),ctx);
  return {WizAppCapture:{reloadCheck:ctx.reloadCheck,getState:()=>({error:active?.error?.code || recoveryError?.code || null})}};
}
const cases=[
  [{recoveryError:{code:'native_bridge_owned'}}, 'capture_custody_uncertain','native_bridge_owned'],
  [{recoveryError:{code:'storage_failed'}}, 'capture_custody_uncertain','storage_failed'],
  [{recoveryError:{code:'storage_unavailable'}}, 'capture_custody_uncertain','storage_unavailable'],
  [{recoveryError:{code:'native_owner_uncertain'}}, 'capture_custody_uncertain','native_owner_uncertain'],
  [{active:{row:{id:'synthetic'},phase:'error',error:{code:'native_start_failed'}}},'capture','native_start_failed'],
  [{unknownMeetingActive:true},'native_owner_uncertain','none'],
  [{device:'{bad'},'device_recording','none'],
  [{owned:[{id:'synthetic',status:'stopping'}]},'capture_custody_uncertain','none'],
  [{owned:[{id:'synthetic',status:'pending'}]},'allowed_now','none'],
];
for (const [seed,reason,error] of cases) test(`served immediate predicate distinguishes ${reason}/${error}`,()=>{
  const host=actualCheck(seed), before=host.WizAppCapture.reloadCheck(); let clock=0;
  const result=readReloadCheck(host,()=>clock++);
  assert.equal(result.reason,reason);assert.equal(result.error,error);assert.equal(result.elapsedMs,1);
  assert.deepEqual(host.WizAppCapture.reloadCheck(),before,'observing cannot change reload safety');
});
test('malicious/private source values never become output',()=>{
  const host={WizAppCapture:{reloadCheck:()=>({reason:'private-title',id:'private-id',safe:false}),getState:()=>({error:'private-text',id:'private-id'})}};
  assert.deepEqual(readReloadCheck(host,()=>0),{reason:'unclassified',error:'unclassified',elapsedMs:0});
});
test('known throw code is reported, not exception text or ID',()=>{
  const host={WizAppCapture:{reloadCheck(){throw Object.assign(Error('PRIVATE'),{code:'SecurityError',id:'PRIVATE'})},getState(){throw Error('not reached')}}};
  assert.deepEqual(readReloadCheck(host,()=>0),{reason:'check_threw',error:'SecurityError',elapsedMs:0});
});
test('standalone/missing shell never invents an empty capture',()=>{
  assert.equal(readReloadCheck(null,()=>0).reason,'shell_unavailable');
  let output={textContent:''}; const win={location:{origin:'https://synthetic.invalid'},document:{querySelector:s=>s.includes('result')?output:{addEventListener(){}}}};win.parent=win;
  showReloadCheck(win);assert.match(output.textContent,/shell_unavailable/);
});
test('fresh app frame reads the existing parent while original capture object stays untouched',()=>{
  const output={textContent:''},events=[];
  const cap={reloadCheck:()=>({safe:false,reason:'capture_custody_uncertain'}),getState:()=>({error:'native_claim_pending'})};
  const parent={WizAppCapture:cap,location:{origin:'https://synthetic.invalid'}};
  const win={parent,location:parent.location,document:{querySelector:s=>s.includes('result')?output:{addEventListener:(t,fn)=>events.push(fn)}}};
  showReloadCheck(win);assert.match(output.textContent,/capture_custody_uncertain/);assert.match(output.textContent,/native_claim_pending/);assert.equal(parent.WizAppCapture,cap);events[0]();assert.equal(parent.WizAppCapture,cap);
});
test('cross-origin access failure stays unknown',()=>{
  const output={textContent:''};const win={location:{origin:'https://synthetic.invalid'},document:{querySelector:s=>s.includes('result')?output:{addEventListener(){}}},parent:{get location(){throw Error('PRIVATE')}}};
  showReloadCheck(win);assert.match(output.textContent,/shell_unavailable/);assert(!output.textContent.includes('PRIVATE'));
});
test('diagnostic panel and button use the transported base/text pair, not missing panel tokens',()=>{
  const css=readFileSync(new URL('reload-check.css',appRoot),'utf8');
  assert(!css.includes('--wz-panel'));
  assert.match(css,/pre\s*\{[^}]*background:\s*var\(--wz-base,\s*#0f1014\)/);
  assert.match(css,/\.reload-check button\.w-btn[^{}]*\{[^}]*color:\s*var\(--wz-text,[^}]*background:\s*var\(--wz-base,\s*#0f1014\)/);
});
test('diagnostic hover and focus keep the base/text pair above legacy button hover specificity',()=>{
  const css=readFileSync(new URL('reload-check.css',appRoot),'utf8');
  const rule=css.match(/([^{}]+)\{([^{}]+)\}/g).find(rule=>rule.includes('.reload-check button.w-btn:hover:not(:disabled)'));
  assert(rule,'explicit scoped hover selector must override legacy .w-btn:hover:not(:disabled)');
  const [selectors,declarations]=rule.split('{');
  assert.deepEqual(selectors.trim().split(/\s*,\s*/),[
    '.reload-check button.w-btn',
    '.reload-check button.w-btn:hover:not(:disabled)',
    '.reload-check button.w-btn:focus-visible',
  ]);
  assert.match(declarations,/color:\s*var\(--wz-text,/);
  assert.match(declarations,/background:\s*var\(--wz-base,/);
});
test('diagnostic imports no recorder core and normal Recorder entry stays unchanged',()=>{
  const html=readFileSync(new URL('reload-check.html',appRoot),'utf8');
  assert(!html.includes('app-capture.js'));assert(!html.includes('src="app.js"'));assert(html.includes('reload-check.js'));
  const diagnostic=readFileSync(new URL('reload-check.js',appRoot),'utf8');
  assert(!/\b(?:fetch|XMLHttpRequest|eval|Function|indexedDB|reconcileReload|recover|recClaim|recStop|ack|pending)\s*\(/.test(diagnostic));
});
