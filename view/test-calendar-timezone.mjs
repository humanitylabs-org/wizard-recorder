import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./web/app.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('const upcomingEvents ='),source.indexOf('const isOngoing ='));
test('calendar uses the device timezone, preserving the original zone without making it an owner default',()=>{
  const zones=[{label:'Asia/Bangkok',count:0},{label:'UTC',count:1}];
  for(const {label,count} of zones){
    const c={Date,Intl:{DateTimeFormat:()=>({resolvedOptions:()=>({timeZone:label})})},state:{calendar:[{start:'2026-10-22T18:00:00Z',end:'2026-10-22T19:00:00Z'}]}};
    vm.createContext(c);vm.runInContext(body+';globalThis.result=upcomingEvents(Date.parse("2026-10-22T00:00:00Z"));',c);
    assert.equal(c.result.length,count);
  }
});
