// Historical labels are test DATA, never production routing/name defaults.
// Execute the actual UI's template expressions with two different installed registries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {publicAgents} from './agent-router.mjs';
const source=fs.readFileSync(new URL('./web/app.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('function mainAgentName()'),source.indexOf('async function wizardAgents()'));
const expressions=[...source.matchAll(/`[^`\n]*\$\{mainAgentName\(\)\}[^`\n]*`/g)].map(m=>m[0]).filter(x=>!x.includes('${mine.') && !x.includes('${a.'));
const historical=[
  {label:'Archimedes'},
  {label:'Archimedes answers'},
  {label:'Ask Archimedes'},
  {label:'Ask Archimedes…'},
  {label:'Asked Archimedes'},
  {label:'Automatic voice requests are disabled. Use Ask Archimedes.'},
  {label:'Message to Archimedes'},
  {label:'Moved to Archimedes'},
  {label:'Nothing sent to Archimedes.'},
  {label:'Open Archimedes answer'},
];
test('live owner labels remain identical when supplied by installed registry; another owner uses their labels',()=>{
  for(const name of ['Archimedes','Fixture guide']){
    const context={agentList:{list:[{id:'main-fixture',label:name,is_default:true,privacy:'standard'}]}};
    vm.createContext(context);vm.runInContext(fn,context);
    const actual=new Set(expressions.map(expression=>vm.runInContext(expression,context)));
    actual.add(vm.runInContext('mainAgentName()',context));
    for(const {label} of historical)assert.ok(actual.has(label.replace('Archimedes',name)),label);
  }
});
test('registry labels may also be the name of a recording source',()=>{
  const label='Mizel';
  const context={agentList:{list:[{id:'source-helper',label,is_default:true}]}};
  vm.createContext(context);vm.runInContext(fn,context);
  assert.equal(vm.runInContext('mainAgentName()',context),label);
});
test('registry names are not rewritten to an owner-specific alias',()=>{
  const label='Hermes', privateLabel='Philosopher';
  const rows=publicAgents({agents:[{id:'generic',label,status:'running',is_default:true},{id:'local',label:privateLabel,privacy:'private',status:'running'}]});
  assert.equal(rows[0].label,label);assert.equal(rows[1].label,privateLabel);
  for(const name of ['server.mjs','agent-router.mjs','web/app.js'])assert.doesNotMatch(fs.readFileSync(new URL(name,import.meta.url),'utf8'),/Archimedes|Philosopher/);
});
