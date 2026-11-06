import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
const base=process.env.RECORDER_QA_BASE,mid=process.env.RECORDER_QA_MEETING,out=process.env.RECORDER_QA_EVIDENCE;
assert(base&&mid&&out);
const browser=await chromium.launch({headless:true,executablePath:process.env.RECORDER_QA_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
const page=await context.newPage(),errors=[],failures=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/favicon.ico'))failures.push({url:r.url(),status:r.status()});});
const results={};
try {
  const opened=await page.goto(base+'/');assert.equal(opened.status(),200);
  await page.locator(`.row[data-id="${mid}"]`).waitFor();
  await page.screenshot({path:path.join(out,'standalone-390.png')});
  await page.locator(`.row[data-id="${mid}"]`).click();
  await page.locator('#segments').waitFor({state:'visible'});
  await page.getByRole('tab',{name:'Transcript',exact:true}).waitFor();
  assert.equal(await page.getByRole('tab',{name:'Summary',exact:true}).count(),0);
  assert.equal(await page.locator('#ask-all').isVisible(),false);
  assert.equal(await page.locator('#ask-meeting').isVisible(),false);
  assert.equal(await page.locator('#doc-route').isVisible(),false);
  assert.match(await page.locator('#segments').innerText(),/bicycle|library|friday|garden|notebook/i);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const original=page.url();
  await page.goBack();
  await page.waitForFunction(()=>document.querySelector('#app').dataset.view==='home');
  assert(page.url().startsWith(base+'/'));
  await page.locator(`.row[data-id="${mid}"]`).click();
  await page.locator('#segments').waitFor({state:'visible'});
  results.standalone={http:opened.status(),nestedBackStayed:true,optionalControlsHidden:true,overflow:false};

  // Host conformance harness: real app facade, real registration/history callbacks.
  // It supplies only appearance and invokes Back; it does not emulate an agent/capture provider.
  const hostURL=new URL('/recorder-qa-host',base).href;
  await page.route(hostURL,route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><script>
  window.WizAppServices={connect:(w,client)=>{window.appClient=client;return null}};
  addEventListener('message',e=>{const d=e.data;if(d?.type==='wizard:app:request'&&d.op==='ready')e.source.postMessage({type:'wizard:app:reply',version:1,id:d.id,value:{version:1,hosted:true}},location.origin)});
  </script><iframe id="app-frame" src="${base}/" style="width:100vw;height:100dvh;border:0"></iframe></body></html>`}));
  await page.goto(hostURL);
  const frame=page.frameLocator('#app-frame');
  await frame.locator(`.row[data-id="${mid}"]`).waitFor();
  await frame.locator(`.row[data-id="${mid}"]`).click();
  await frame.locator('#segments').waitFor({state:'visible'});
  // A nested document, an overlay, then document -> home. All Back calls stay in the frame.
  await frame.locator('#title').waitFor();
  await frame.locator('#doc-actions button').last().click();
  await frame.getByRole('menu').waitFor();
  assert.equal(await page.evaluate(()=>appClient.back()),true);
  await frame.getByRole('menu').waitFor({state:'hidden'});
  assert((await frame.locator('#title').innerText()).length>0);
  assert.equal(await page.evaluate(()=>appClient.back()),true);
  await frame.locator('#app[data-view="home"]').waitFor();
  assert.equal(await page.evaluate(()=>appClient.back()),false); // Shell keeps the app at its root.
  assert.equal(page.url(),hostURL);
  await frame.locator(`.row[data-id="${mid}"]`).click();
  await frame.locator('#segments').waitFor({state:'visible'});
  const dark={canvas:'#111318',base:'#111318',chrome:'#191d25',overlay:'#242a34',surface:'#191d25','surface-raised':'#252c38',text:'#f1f3f9','text-secondary':'#c1c8d7','text-muted':'#939eaf',border:'#3f4857',accent:'#b9a3ff','accent-soft':'#3d315e','on-accent':'#14111c','reader-surface':'#191d25'};
  const light={canvas:'#f5f1e8',base:'#f5f1e8',chrome:'#eee8dc',overlay:'#fffdf8',surface:'#fffdf8','surface-raised':'#e9e1d4',text:'#252c33','text-secondary':'#414c59','text-muted':'#637080',border:'#b5b0a6',accent:'#6940ac','accent-soft':'#e8dff6','on-accent':'#ffffff','reader-surface':'#fffdf8'};
  let revision=1;
  for(const [skin,tokens] of [['dark',dark],['light',light]]) {
    await page.evaluate(({skin,tokens,revision})=>document.querySelector('iframe').contentWindow.postMessage({type:'wizard:appearance',appearance:{version:1,revision,presentation:'window',colorScheme:skin,skin:'proof-'+skin,tokens}},location.origin),{skin,tokens,revision:revision++});
    await frame.locator(`html[data-skin="proof-${skin}"]`).waitFor();
    const value=await frame.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--wz-base').trim());assert.equal(value,tokens.base);
    assert.match(await frame.locator('#segments').innerText(),/bicycle|library|friday|garden|notebook/i);
    assert.equal(await frame.locator('html').evaluate(el=>el.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(out,skin+'-skin-390.png')});
  }
  results.hosted={nestedOverlayAndDocumentBackStayed:true,skins:['dark','light'],liveSkinChangePreservedTranscript:true,width:390};
  assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
  fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify({...results,errors,failures},null,2));
  console.log(JSON.stringify(results));
} catch(e) {
  await page.screenshot({path:path.join(out,'browser-failure.png')});
  fs.writeFileSync(path.join(out,'browser-failure.json'),JSON.stringify({error:e.stack,errors,failures},null,2));throw e;
} finally {await browser.close();}
