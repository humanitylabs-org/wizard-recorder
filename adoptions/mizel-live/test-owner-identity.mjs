import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ownerIdentityPrompt } from './owner-identity.mjs';
import { transcriptPacket } from './agent-router.mjs';

for (const [configured, expected] of [['James', 'James'], [' Alex ', 'Alex'], [undefined, 'the device owner'], ['  ', 'the device owner']]) {
  test(`owner framing: ${String(configured)}`, async () => {
    const env = configured === undefined ? {} : { MEETINGS_OWNER_NAME: configured };
    const framing = ownerIdentityPrompt(env);
    assert(framing.includes(`${expected} is the recorder and the owner of these notes`));
    assert(framing.includes(`Lines labelled Me come from ${expected}'s microphone`));
    assert(framing.includes("other people's speech can also appear under Me"));
    assert(framing.includes(`means ${expected} is recording and X is the other participant`));
    if (configured !== 'James') assert(!framing.includes('James'));
    const oldOwner = process.env.MEETINGS_OWNER_NAME;
    try {
      if (configured === undefined) delete process.env.MEETINGS_OWNER_NAME;
      else process.env.MEETINGS_OWNER_NAME = configured;
      const packet = transcriptPacket({meeting:{title:'Fixture',segments:[{source:'me',text:'I am doing an SS recording with Novaire.',start_ms:0}]}});
      assert(packet.text.includes(framing));
      assert(packet.text.includes('Me: I am doing an SS recording with Novaire.'));
    } finally {
      if (oldOwner === undefined) delete process.env.MEETINGS_OWNER_NAME;
      else process.env.MEETINGS_OWNER_NAME = oldOwner;
    }

    // Exercise the real live-outline request builder without starting its server.
    const src = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
    const code = src.slice(src.indexOf('const SUMMARY_PROMPT ='), src.indexOf('// Walk a finished transcript'));
    let request;
    const ctx = vm.createContext({
      ownerIdentityPrompt: () => framing,
      state: { summaries: {}, asks: {} },
      fetch: async () => ({ok:true,json:async()=>({segments:[{source:'me',start_ms:0,end_ms:5000,text:'I am doing an SS recording with Novaire.'}]})}),
      UP: {host:'fixture',port:1,base:''},
      provider: {client:{chat:{completions:{create:async r => {request=r; return {choices:[{message:{content:'fixture'}}]};}}}}},
      parseSummaryDelta: () => ({title:'Fixture',topicChanged:false,newBullets:[]}),
      SUMMARY_MODEL:'fixture', crypto:{randomUUID:()=> 'fixture'}, save(){}, logEvent(){}, broadcast(){},
    });
    vm.runInContext(code + '\nglobalThis.run = summarizeMeeting;', ctx);
    await ctx.run('fixture', {force:true});
    assert(request.messages[0].content.includes(framing));
    const input = JSON.parse(request.messages[1].content);
    assert.equal(input.transcript[0].speaker, 'Me');
    assert.equal(input.transcript[0].text, 'I am doing an SS recording with Novaire.');

    // Exercise the provider summary method with an injected fake client, no SDK/network.
    const providerSrc = fs.readFileSync(new URL('./provider.js', import.meta.url), 'utf8');
    const providerCode = providerSrc.slice(providerSrc.indexOf('export class TinfoilProvider'), providerSrc.indexOf('/**')).replace('export class', 'class');
    const providerCtx = vm.createContext({ ownerIdentityPrompt: () => framing, parseSummaryDelta: () => ({}) });
    vm.runInContext(providerCode + '\nglobalThis.Provider=TinfoilProvider;', providerCtx);
    const client={chat:{completions:{create:async r => {request=r;return {choices:[{message:{content:'fixture'}}]};}}}};
    await new providerCtx.Provider('',client).summarize({transcript:input.transcript});
    assert(request.messages[0].content.includes(framing));
    // Manual asks must stay explicitly typed text only, never recording context.
    assert.match(src, /function promptFor\(ask\)\s*\{[^}]*return ask.text;/);
  });
}
