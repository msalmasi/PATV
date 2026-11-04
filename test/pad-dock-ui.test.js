"use strict";
// 1.99?? dockclean: the Room Dock's controller after the clean-up (hand-off 18 follow-up) - one stage card with an auto-hiding overlay,
// the chat's one header row, the composer's tool row, and every other control in exactly one menu that proxies the original control.
const test=require('node:test'),assert=require('node:assert/strict');
const {harness,Event}=require('./fixtures/pad-dock/dom.cjs');
const F=require('./fixtures/pad-dock/room.cjs');
const flush=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
const menuOf=doc=>doc.querySelector('.rmd-menu');
test('Live framing follows the actual tab; no pad bar or drawer, the identity is the stage card\'s pad chip',()=>{
  const h=harness();assert.equal(h.doc.body.classList.contains('pad-dock-live'),true);
  assert.equal(h.doc.getElementById('rmdBar'),null);assert.equal(h.doc.getElementById('rmdDrawer'),null);
  const chip=h.stage.querySelector('.rmd-ov-top .rmd-chip');assert.ok(chip,'the pad chip sits in the overlay\'s top bar');assert.match(chip.textContent,/Night Orchard/);assert.equal(chip.getAttribute('aria-haspopup'),'menu');
  // Feed / About: the tabs are a segment inside the header's one row, with the pad menu's ▾ at its end
  assert.equal(h.tabsNav.parentNode===h.hero.querySelector('.hd'),true);assert.ok(h.tabsNav.classList.contains('ds-seg'));assert.ok(h.hero.querySelector('.hd-acts .rmd-chip-head'));
  for(const tab of ['feed','about','live']){h.doc.dispatchEvent(new Event('patv:padtab',{detail:{tab}}));assert.equal(h.doc.body.classList.contains('pad-dock-live'),tab==='live');}
  h.controller.destroy();assert.equal(h.doc.body.classList.contains('pad-dock-live'),false);assert.equal(harness({feed:true}).doc.body.classList.contains('pad-dock-live'),false);
});
test('the pinned cams live inside the stage card; the chat log and its New messages pill share one box',()=>{
  const h=harness();assert.equal(h.strip.parentNode===h.stage,true);assert.ok(h.strip.classList.contains('rmd-strip'));
  const log=h.doc.querySelector('.rmd-log');assert.ok(log);assert.equal(h.doc.getElementById('rmScroll').parentNode===log,true);assert.equal(h.doc.getElementById('rmJump').parentNode===log,true);
  const kids=h.chat.children;assert.equal(kids.indexOf(h.doc.getElementById('rmAudioBox'))+1,kids.indexOf(h.compose),'the audio bar sits right above the composer');
});
test('float, fullscreen and redock move the same feed and preserve privacy markup',async()=>{
  const h=harness(),same=h.feed,before=h.feed.outerHTML,story=h.story;h.menuPick('Chat options','Float chat');
  assert.ok(h.chat.closest('.rmd-float'));assert.ok(h.root.contains(h.chat));assert.equal(h.doc.getElementById('rmFeed'),same);assert.equal(h.feed.outerHTML,before);assert.equal(story.ownerDocument,h.doc);assert.equal(h.chat.contains(story),false);
  h.controller.redock();assert.equal(h.chat.closest('.rmd-float'),null);assert.equal(h.doc.querySelectorAll('#rmFeed').length,1);
  h.button('Fullscreen',h.stage).click();await flush();assert.ok(h.root.contains(h.doc.fullscreenElement));h.button('Show chat').click();assert.ok(h.chat.closest('.rmd-overlay'));assert.equal(h.doc.getElementById('rmFeed'),same);assert.equal(h.feed.outerHTML,before);assert.equal(h.chat.contains(story),false);
  h.button('Show chat').click();assert.equal(h.chat.closest('.rmd-overlay'),null);h.controller.redock();assert.equal(h.doc.getElementById('rmFeed'),same);assert.equal(h.doc.querySelectorAll('#rmPtt').length,1);
});
test('Document PiP adopts one log, exact pad identity and all stylesheets; close restores it',async()=>{
  const h=harness({pip:true}),before=h.feed.outerHTML,styles=h.doc.querySelectorAll('link[rel="stylesheet"],style').length;
  h.menuPick('Chat options','Pop out chat');await flush();const p=h.pipDoc,main=p.querySelector('main');
  assert.equal(p.getElementById('rmFeed'),h.feed);assert.equal(h.doc.getElementById('rmFeed'),null);assert.equal(h.feed.outerHTML,before);assert.equal(main.className,h.root.className);assert.equal(main.getAttribute('style'),h.root.getAttribute('style'));assert.equal(p.querySelectorAll('link[rel="stylesheet"],style').length,styles);assert.equal(p.querySelector('.rm-story'),null);
  h.doc.hidden=true;assert.equal(h.controller.visible(),true);p.hidden=true;assert.equal(h.controller.visible(),false);p.hidden=false;
  h.button('Add to the chat',p).click();assert.ok(menuOf(p));assert.equal(p.querySelectorAll('button').some(b=>b.textContent.includes('Add to your story')),false);
  h.doc.dispatchEvent(new Event('keydown',{key:'Escape'}));p.dispatchEvent(new Event('keydown',{key:'Escape'}));
  h.button('Pepe says it',p).click();assert.ok(p.querySelector('.rmd-tts'));assert.equal(h.doc.querySelector('.rmd-tts'),null);
  h.pipWin.close();assert.equal(h.doc.getElementById('rmFeed'),h.feed);assert.equal(h.doc.querySelectorAll('#rmFeed').length,1);assert.equal(h.feed.outerHTML,before);assert.ok(h.calls.adopt.includes(p));assert.equal(h.calls.adopt.at(-1),h.doc);
});
test('topmost foreign dialogs own Escape and focus before the floating Dock',()=>{
  const h=harness();h.menuPick('Chat options','Float chat');const float=h.chat.closest('.rmd-float');
  const modal=h.make('div',null,null,h.doc.body);modal.setAttribute('aria-modal','true');const field=h.make('input',null,null,modal);field.focus();
  h.doc.dispatchEvent(new Event('keydown',{key:'Escape'}));assert.equal(h.chat.closest('.rmd-float'),float);assert.equal(h.doc.activeElement,field);
  modal.remove();h.doc.dispatchEvent(new Event('keydown',{key:'Escape'}));assert.equal(h.chat.closest('.rmd-float'),null);
});
test('the tool row: Say it and Apps share the relay; tiles fill the composer and never send; ＋ holds no duplicates',()=>{
  const h=harness({data:d=>{d.room.cmds={'!say':100,'!duel':0,'!bj':0,'!spin':5000,'!pictionary':0};}});
  assert.equal(h.input.maxLength,300);assert.equal(h.ptt.closest('form'),null);assert.equal(h.input.closest('.rmd-input-row'),h.ptt.parentNode);assert.equal(h.send.closest('.rmd-input-row'),h.ptt.parentNode);
  const tools=h.compose.querySelector('.rmd-tools');assert.ok(tools);assert.equal(tools.parentNode===h.ptt.parentNode,true,'the tool row is the composer box\'s second row');
  h.button('Pepe says it').click();let sheet=h.doc.querySelector('.rmd-tts');assert.match(sheet.textContent,/100 PAT/);sheet.querySelector('input').value='A quiet hello';sheet.dispatchEvent(new Event('submit'));assert.deepEqual(h.calls.send,['!say A quiet hello']);
  h.button('Chat apps').click();let apps=h.doc.querySelector('.rmd-layer');assert.match(apps.textContent,/Duel/);assert.match(apps.textContent,/Blackjack/);assert.match(apps.textContent,/Spin/);assert.match(apps.textContent,/Pictionary/);
  assert.doesNotMatch(apps.textContent,/Brawl|Hold’em|Heist/);assert.equal(apps.querySelector('a[href*="/wheel"]'),null,'no Wheel link: 🎡 is !spin');
  assert.match(apps.querySelector('.rmd-app[aria-label^="Spin"]').textContent,/5,000 PAT/);
  h.button('Duel (!duel), free',apps).click();assert.equal(h.input.value,'!duel ');assert.equal(h.calls.send.length,1);
  h.button('Chat apps').click();h.button('Spin (!spin), 5,000 PAT',h.doc.querySelector('.rmd-layer')).click();assert.equal(h.input.value,'!spin');assert.equal(h.calls.send.length,1,'a tile never sends');
  h.button('Add to the chat').click();const plus=menuOf(h.doc).textContent;assert.doesNotMatch(plus,/Tip|Soundboard|Pepe says it|Chat apps|Stickers|GIF/);assert.match(plus,/Clip this chat/);h.doc.dispatchEvent(new Event('keydown',{key:'Escape'}));
  const d=F.initial();delete d.room.cmds['!say'];h.controller.update(d);assert.equal(h.root.querySelector('[data-rmd-tts]').hidden,true);
  assert.equal(h.doc.querySelectorAll('button').some(b=>!b.hidden&&/GIF|Stickers|Emoji/.test(b.getAttribute('aria-label')||'')),false,'no picker tools without the picker');
});
test('Say it offers the site\'s voices and sends the voice flag (quoted when the id has a space); the price line adds the voice',async()=>{
  const voices=[{id:'stock one',display:'Stock One',kind:'stock',status:'active',listed:true,in_voicebox:true,price_use:250,owned:false,free:false,sample:'/sb/audio/vs-1.wav'},
    {id:'clone2',display:'Clone Two',kind:'clone',status:'active',listed:true,in_voicebox:true,allow_free_text:false,price_use:0,free:true},{id:'paused',display:'Paused',status:'paused',listed:true,in_voicebox:true}];
  const h=harness({picker:{voices:()=>Promise.resolve(voices),available:()=>false}});
  h.button('Pepe says it').click();await flush();const sheet=h.doc.querySelector('.rmd-tts'),sel=sheet.querySelector('select');
  assert.deepEqual(sel.children.map(o=>o.value),['','stock one'],'no clone without free text, no paused voice');assert.match(sel.children[1].textContent,/Stock One · \+250 PAT per use/);
  sel.value='stock one';sel.dispatchEvent(new Event('change'));assert.match(sheet.querySelector('.rmd-price').textContent,/voice 250 PAT/);
  sheet.querySelector('input').value='Hello there';sheet.dispatchEvent(new Event('submit'));assert.deepEqual(h.calls.send,['!say Hello there -v "stock one"']);
});
test('soundboard and story entry use the originals and restore soundboard on close',()=>{
  const h=harness(),parent=h.sb.parentNode;h.button('Soundboard',h.compose.querySelector('.rmd-tools')).click();assert.ok(h.doc.querySelector('.rmd-layer').contains(h.sb));assert.equal(h.doc.querySelectorAll('#rmSb').length,1);assert.equal(h.sb.querySelector('.sbd-toggle').getAttribute('aria-expanded'),'true');h.button('Close').click();assert.equal(h.sb.parentNode,parent);
  h.menuPick('Add to the chat','Add to your story');assert.equal(h.calls.story,1);assert.equal(h.story.ownerDocument,h.doc);
});
test('holder chips use shared rendering and veiled people have no actionable identity',()=>{
  const h=harness(),holders=h.doc.querySelector('.rmd-holders');assert.equal(h.calls.avatar,2);assert.equal(h.calls.name,2);assert.match(holders.textContent,/Misty Froglet/);
  const veiled=holders.children[1];assert.doesNotMatch(veiled.outerHTML,/opaque-cam|data-u|href=/);assert.equal(veiled.querySelector('a,button,[role="button"]'),null);assert.equal(veiled.querySelector('.cam'),null);
  const normal=holders.children[0].querySelector('.who');normal.click();assert.equal(h.calls.person.length,1);normal.dispatchEvent(new Event('click',{ctrlKey:true}));assert.equal(h.calls.person.length,1);
  for(const line of h.feed.querySelectorAll('.line[data-vc]')){assert.equal(line.getAttribute('data-c'),null);assert.equal(line.getAttribute('data-text'),null);}
});
test('the bottom bar: [▶] [now] [🔊 volume 🎚️] - no duck, mode or A/V-sync buttons in the row; they are Audio settings',()=>{
  const h=harness({avsync:true}),row=h.doc.querySelector('#rmAudioBox .rb-audio');
  assert.ok(row.classList.contains('rmd-bar'));const now=row.querySelector('.rmd-now'),right=row.querySelector('.rmd-right');assert.ok(now&&right);
  assert.equal(right.querySelector('.rb-mute')!==null&&right.querySelector('.rb-vol')!==null,true);assert.equal(now.querySelector('.rmd-holders')!==null,true);assert.equal(now.querySelector('.rb-state')!==null,true);
  assert.equal(h.doc.querySelectorAll('button').some(b=>b.getAttribute('aria-label')==='Duck while recording'),false);
  h.button('Audio settings').click();const pop=h.doc.querySelector('.rmd-audio-pop');assert.ok(pop);assert.match(pop.textContent,/Not playing/);
  const sw=pop.querySelectorAll('input[role="switch"]');assert.equal(sw.length,2,'duck + A/V sync');
  sw[0].checked=true;sw[0].dispatchEvent(new Event('change'));assert.equal(h.controller&&sw[0].getAttribute('aria-checked'),'true');
  sw[1].checked=false;sw[1].dispatchEvent(new Event('change'));assert.deepEqual(h.calls.clicks.filter(x=>x==='avsync'),['avsync']);assert.equal(sw[1].checked,false);
  assert.ok(h.doc.querySelector('.rmd-audio-pop'),'review: av-sync\'s own button clicked FOR the switch is not a click outside - the panel stays open');
  h.calls.recordFn(true);h.calls.recordFn(false);assert.deepEqual(h.calls.record,[true,false]);
});
test('recording-time duck delegates to the shared audio object and survives moves',()=>{
  const h=harness();h.button('Audio settings').click();const sw=h.doc.querySelector('.rmd-audio-pop input[role="switch"]');sw.checked=true;sw.dispatchEvent(new Event('change'));
  h.calls.recordFn(true);h.calls.recordFn(false);assert.deepEqual(h.calls.record,[true,false]);h.doc.dispatchEvent(new Event('keydown',{key:'Escape'}));
  h.menuPick('Chat options','Float chat');h.calls.recordFn(true);assert.deepEqual(h.calls.record,[true,false,true]);h.controller.redock();assert.equal(h.doc.querySelectorAll('#rmAudioBox').length,1);
});
test('a pinned cam: one ⋯ per tile (watch on my stage, fullscreen, cam options, close) and a click on its video watches it',()=>{
  const h=harness(),tile=h.tile,video=tile.querySelector('video');
  h.menuPick('Cam options','Watch on my stage');assert.equal(h.root.classList.contains('rmd-local-cam'),true);const local=h.doc.querySelector('.rmd-local-player');
  assert.equal(local.parentNode===h.stage,true,'the local player is the stage card\'s main area');assert.equal(local.querySelector('.cs-tile')===tile,true);assert.equal(tile.querySelector('video')===video,true);assert.equal(h.strip.querySelector('.cs-tile'),null);
  h.button('Return cam to strip').click();assert.equal(h.strip.querySelector('.cs-tile')===tile,true);
  video.click();assert.equal(h.root.classList.contains('rmd-local-cam'),true);h.button('Return cam to strip').click();
  h.menuPick('Cam options','Cam options…');assert.equal(h.calls.cam.length,1);assert.equal(h.calls.cam[0].login,'willow_fable');assert.ok(h.calls.cam[0].patv,'the person as the room lists them now (review: the strip keeps only a reference)');
  h.tile._who={login:'gone_fable'};h.button('Cam options').click();assert.equal(menuOf(h.doc).querySelectorAll('button').some(b=>/Cam options…/.test(b.textContent)),false,'no Cam options for someone who left');h.button('Cam options').click();
  h.menuPick('Cam options','Close (frees the slot)');assert.deepEqual(h.calls.clicks.filter(x=>x==='cam-x'),['cam-x']);
});
test('the stage ⋯: hide the stage to its slim bar, pop out, pinned cams ▸ layouts',()=>{
  const h=harness();
  h.menuPick('Stage options','Hide stage');assert.equal(h.root.classList.contains('rmd-stage-hidden'),true);const mini=h.doc.getElementById('rmdMini');assert.equal(mini.hidden,false);assert.ok(mini.querySelector('.rmd-chip'));
  h.button('Show stage').click();assert.equal(h.root.classList.contains('rmd-stage-hidden'),false);
  h.menuPick('Stage options','Pop out player');assert.match(h.doc.querySelector('.rmd-toast').textContent,/unavailable/);assert.equal(h.stage.querySelector('video').ownerDocument,h.doc);
  h.button('Stage options').click();h.button('Pinned cams',menuOf(h.doc)).click();const m=menuOf(h.doc);assert.ok(m,'the submenu replaces the list');h.button('Grid',m).click();assert.equal(h.strip.getAttribute('data-rmd-layout'),'grid');
});
test('the overlay\'s Snap and Clip proxy the capture row; Clip asks for the length first and then starts it',()=>{
  const h=harness(),snap=h.button('Snap · 100 PAT · preview first, pay only if you save');assert.equal(snap.hidden,false);snap.click();assert.deepEqual(h.calls.clicks,['snap']);
  const clip=h.stage.querySelectorAll('.rmd-ov-bot button').find(b=>b.getAttribute('aria-haspopup')==='menu'&&/^Clip/.test(b.getAttribute('aria-label')));clip.click();const m=menuOf(h.doc);assert.equal(m.querySelectorAll('[role="menuitemradio"]').length,3);
  assert.equal(m.querySelectorAll('[role="menuitemradio"]').find(b=>b.getAttribute('aria-checked')==='true').textContent.includes('20 s'),true);
  h.button('30 s',m).click();assert.equal(h.doc.querySelector('#rmCap .stcap-secs').value,'30');assert.deepEqual(h.calls.clicks,['snap','clip']);
  const none=harness({capture:false});assert.equal(none.stage.querySelectorAll('.rmd-ov-bot button').filter(b=>/^(Snap|Clip)/.test(b.getAttribute('aria-label'))&&!b.hidden).length,0,'no capture row: no Snap / Clip');
});
test('the source chip is a menu of the stage\'s sources (the original tabs)',()=>{
  const h=harness(),chip=h.stage.querySelector('button.rmd-src');assert.match(chip.textContent,/On the mic \(2\)/);
  // (review: built once and painted in place - an update, a pointer move or the overlay showing again never swaps the node)
  h.controller.update(F.initial());h.stage.dispatchEvent(new Event('pointermove',{bubbles:true}));assert.equal(h.stage.querySelector('button.rmd-src')===chip,true,'the same node');
  chip.click();
  const m=menuOf(h.doc),items=m.querySelectorAll('[role="menuitemradio"]');assert.equal(items.length,2);assert.equal(items[0].getAttribute('aria-checked'),'true');
  items[1].click();assert.deepEqual(h.calls.clicks,['stab:pepe']);
});
test('fullscreen body-attached controls leave fullscreen before replay; PiP controls focus pad',async()=>{
  const h=harness({pip:true}),line=h.feed.querySelector('.line'),action=h.make('button','la-btn',null,line,'Line actions');let invoked=0;action.addEventListener('click',()=>invoked++);
  h.button('Fullscreen',h.stage).click();h.button('Show chat').click();action.click();await flush();assert.equal(h.doc.fullscreenElement,null);assert.equal(invoked,1);assert.equal(h.doc.getElementById('rmFeed'),h.feed);
  h.menuPick('Chat options','Pop out chat');await flush();action.click();assert.equal(invoked,1);assert.equal(h.calls.focus,1);assert.match(h.pipDoc.querySelector('.rmd-toast').textContent,/pad tab/);
});
test('a disabled text relay cannot hide a separately enabled mic relay',()=>{
  const h=harness(),form=h.input.closest('form');form.classList.add('hide');assert.equal(h.ptt.closest('.hide'),null);assert.equal(h.ptt.closest('form'),null);assert.equal(h.ptt.getClientRects().length,1);assert.equal(h.doc.querySelectorAll('#rmPtt').length,1);
});
test('a late Document PiP result after leaving Live closes without moving chat',async()=>{
  const h=harness({pip:true,deferPiP:true}),before=h.feed.outerHTML;h.menuPick('Chat options','Pop out chat');h.panel.hidden=true;h.doc.dispatchEvent(new Event('patv:padtab',{detail:{tab:'feed'}}));h.resolvePip();await flush();assert.equal(h.pipWin.closed,true);assert.equal(h.doc.getElementById('rmFeed'),h.feed);assert.equal(h.feed.outerHTML,before);assert.equal(h.doc.body.classList.contains('pad-dock-live'),false);
});
test('a live veil change closes the named tip picker and invalidates its previously rendered recipient action',()=>{
  const h=harness(),d=F.initial();
  d.members[0].tip={to:'aster-fable',href:'/u/aster-fable'};h.controller.update(d);
  const open=()=>{h.button('Tip',h.compose.querySelector('.rmd-tools')).click();};
  open();let picker=h.doc.querySelector('.rmd-layer');
  assert.match(picker.textContent,/Aster Fable/);
  const stale=picker.querySelectorAll('button').find(b=>b.textContent==='Aster Fable');assert.ok(stale);
  d.members[0]={anon:true,veil:'hidden',alias:'Moonlit Froglet',hood:2};h.controller.update(d);
  // (review: the sheet stays open - a poll no longer closes it under someone using its search - and the named entry leaves at once)
  assert.ok(h.doc.querySelector('.rmd-layer'),'the sheet stays');assert.doesNotMatch(h.doc.querySelector('.rmd-layer').textContent,/Aster Fable/,'privacy updates remove the named recipient at once');assert.equal(stale.isConnected,false);
  stale.click();assert.equal(h.calls.tip.length,0,'a queued activation cannot use the old named identity');
  open();picker=h.doc.querySelector('.rmd-layer');assert.doesNotMatch(picker.textContent,/Aster Fable/);assert.match(picker.textContent,/No eligible recipients/);
  h.button('Close').click();
  const again=F.initial();again.members[0].tip={to:'aster-fable',href:'/u/aster-fable'};again.web=[{web:true,display:'quill-fable',patv:{username:'quill-fable'},tip:{to:'quill-fable',href:'/u/quill-fable/tip'}},{web:true,display:'viewer-fable',patv:{username:'viewer-fable'},me:true}];
  h.controller.update(again);open();const list=h.doc.querySelector('.rmd-layer');assert.match(list.textContent,/quill-fable/,'web users can be tipped too');assert.doesNotMatch(list.textContent,/viewer-fable/,'never yourself');
  list.querySelectorAll('button').find(b=>b.textContent==='Aster Fable').click();
  assert.equal(h.calls.tip.length,1);assert.equal(h.calls.tip[0].to,'aster-fable');assert.equal(h.calls.tip[0].display,'Aster Fable');
  h.controller.destroy();
});
test('sheets opened from the tool row and the ＋ menu restore focus to their opener',()=>{
  const h=harness(),tools=h.compose.querySelector('.rmd-tools');
  for(const label of ['Pepe says it','Chat apps','Soundboard','Tip']){
    const opener=h.button(label,tools);opener.focus();opener.click();assert.ok(h.doc.querySelector('.rmd-layer'),label);h.button('Close',h.doc.querySelector('.rmd-layer')).click();
    assert.equal(h.doc.activeElement===opener,true,label+' returns focus to its tool');
  }
  h.controller.destroy();
});
test('a camera watched on the local stage keeps reachable hide, restore and pop-out controls without creating a second player',async()=>{
  const h=harness({pip:true}),tile=h.tile,video=tile.querySelector('video');
  h.menuPick('Cam options','Watch on my stage');const local=h.doc.querySelector('.rmd-local-player');
  h.button('Hide stage',local).click();assert.equal(h.root.classList.contains('rmd-stage-hidden'),true);assert.equal(h.doc.getElementById('rmdMini').hidden,false);
  h.button('Show stage').click();assert.equal(h.root.classList.contains('rmd-stage-hidden'),false);assert.equal(local.contains(tile),true);
  h.button('Pop out player',local).click();await flush();
  assert.equal(h.pipDoc.querySelector('.rmd-local-player')===local,true);assert.equal(h.pipDoc.querySelector('.cs-tile')===tile,true);
  assert.equal(tile.querySelector('video')===video,true);assert.equal(h.doc.querySelectorAll('.cs-tile').length,0);
  h.pipWin.close();assert.equal(h.doc.querySelector('.rmd-local-player')===local,true);assert.equal(local.contains(tile),true);
  h.button('Return cam to strip').click();assert.equal(h.strip.querySelector('.cs-tile')===tile,true);assert.equal(h.doc.querySelectorAll('.cs-tile').length,1);assert.equal(tile.querySelector('video')===video,true);
  h.controller.destroy();
});
test('menus support arrows, Home, End and Escape in the pad and PiP documents',async()=>{
  for(const pip of [false,true]){
    const h=harness({pip});if(pip){h.menuPick('Chat options','Pop out chat');await flush();}
    const doc=pip?h.pipDoc:h.doc,opener=h.button('Chat options',doc);opener.click();
    const menu=menuOf(doc),items=menu.querySelectorAll('[role="menuitem"]');assert.ok(items.length>=3);
    assert.equal(doc.activeElement===items[0],true,'opening a menu focuses its first action');assert.equal(opener.getAttribute('aria-expanded'),'true');
    const key=(key,index)=>{const e=new Event('keydown',{key});doc.dispatchEvent(e);assert.equal(e.defaultPrevented,true);assert.equal(doc.activeElement===items[index],true,key+' focuses the expected action');};
    key('ArrowDown',1);key('End',items.length-1);key('ArrowDown',0);key('ArrowUp',items.length-1);key('Home',0);
    doc.dispatchEvent(new Event('keydown',{key:'Escape'}));assert.equal(menu.isConnected,false);assert.equal(doc.activeElement===opener,true);assert.equal(opener.getAttribute('aria-expanded'),'false');
    h.controller.destroy();
  }
});
test('Dock notices reuse the body toast stack and remain inside fullscreen and PiP surfaces',async()=>{
  const h=harness({pip:true}),stack=h.make('div','ds-toasts',null,h.doc.body),existing=h.make('div','ds-toast',null,stack,'Existing notice');
  const plain=harness(),plainStack=plain.make('div','ds-toasts',null,plain.doc.body),plainNotice=plain.make('div','ds-toast',null,plainStack,'Existing notice');
  plain.menuPick('Stage options','Pop out player');const first=plain.doc.querySelector('.rmd-toast');
  assert.equal(first.parentNode===plainStack,true);assert.equal(plain.root.contains(first),false);assert.equal(plainNotice.isConnected,true);
  plain.menuPick('Stage options','Pop out player');assert.equal(first.isConnected,false);assert.equal(plain.doc.querySelectorAll('.ds-toasts').length,1);assert.equal(plain.doc.querySelectorAll('.rmd-toast').length,1);
  const action=h.make('button','la-btn',null,h.feed.querySelector('.line'),'Line actions');
  h.button('Fullscreen',h.stage).click();await flush();h.button('Show chat').click();const full=h.doc.fullscreenElement;
  const exit=h.doc.exitFullscreen.bind(h.doc);h.doc.exitFullscreen=()=>Promise.reject(new Error('Fullscreen exit refused'));
  action.click();await flush();assert.equal(h.doc.fullscreenElement===full,true);assert.equal(full.querySelector('.rmd-toast').closest('.ds-toasts').parentNode===full,true);assert.equal(existing.isConnected,true);
  h.doc.exitFullscreen=exit;await exit();h.controller.redock();h.menuPick('Chat options','Pop out chat');await flush();action.click();
  const notice=h.pipDoc.querySelector('.rmd-toast');assert.equal(notice.closest('.ds-toasts').parentNode===h.pipDoc.querySelector('main'),true);assert.equal(h.doc.querySelectorAll('.ds-toasts').length,1);
  plain.controller.destroy();h.controller.destroy();
});
test('the topic is one line in the chat header: editable text for editors (Manage room opens on it), readable for everyone else',()=>{
  let allowed=true;const h=harness({mod:true,opts:{canTopic:()=>allowed}}),topic=h.doc.getElementById('rmTopic');
  assert.equal(topic.parentNode.classList.contains('rmd-topic-line'),true);assert.equal(topic.parentNode.parentNode===h.chatH,true);
  assert.equal(h.chatH.querySelectorAll('button').some(b=>b.getAttribute('aria-label')==='Edit topic'),false,'no ✏️ button');
  assert.equal(topic.getAttribute('role'),'button');assert.match(topic.getAttribute('aria-label'),/^Edit topic: Tonight in the orchard/);
  topic.click();h.tick();assert.equal(h.calls.topic,1,'the topic editor opens once the sheet is up (after its first focus)');assert.ok(h.doc.querySelector('.rmd-layer').contains(h.doc.getElementById('rmMod')),'the Manage room sheet');h.button('Close').click();
  topic.dispatchEvent(new Event('keydown',{key:'Enter'}));h.tick();assert.equal(h.calls.topic,2);h.button('Close').click();
  allowed=false;h.controller.update(F.initial());assert.match(topic.getAttribute('aria-label'),/^Topic: /);topic.click();assert.equal(h.calls.topic,2,'a stale activation rechecks permission');
});
test('Participants holds ONLY the people card; a person menu or camera popup opens over it, next to its row, and owns the keys',()=>{
  const h=harness(),card=h.ppl,home=card.parentNode,icons=h.make('span','ic',null,card);
  const pplBtn=()=>h.chatH.querySelector('.rmd-ppl-btn');pplBtn().click();const sheet=h.doc.querySelector('.rmd-layer');assert.ok(sheet.contains(card));assert.equal(sheet.contains(h.side),false,'never the whole side column');assert.match(sheet.querySelector('h2').textContent,/In the room · 6/);
  h.button('Close').click();assert.equal(card.parentNode===home,true);
  for(const [cls,parent] of [['pm-mg',card],['cam',icons]]){
    const trigger=h.make('button',cls,null,parent,'Existing action');let panel,field,restoredAtOpen=false;
    trigger.addEventListener('click',()=>{
      restoredAtOpen=card.parentNode===home;
      panel=h.make('div',cls==='cam'?'snap':'pm-pop',null,h.doc.body);panel.setAttribute('role','dialog');
      field=h.make('button',null,null,panel,'Existing popover action');field.focus();
    });
    pplBtn().click();trigger.click();
    // (review: putting the card back first left the menu's anchor without a box below 1024px - it opened in the page's corner)
    assert.equal(restoredAtOpen,false,'the anchor stays in the sheet');assert.equal(trigger.isConnected,true);assert.ok(h.doc.querySelector('.rmd-layer'),'the sheet stays underneath');
    assert.equal(h.doc.activeElement===field,true,'the Participants trap does not steal popover focus');
    h.doc.dispatchEvent(new Event('keydown',{key:'Escape',bubbles:true}));assert.ok(h.doc.querySelector('.rmd-layer'),'Escape in the popover is the popover\'s');
    panel.remove();h.button('Close').click();assert.equal(card.parentNode===home,true);
  }
  h.controller.destroy();
});
test('the people card: a find field filters by the name shown, the freshness note becomes an ℹ️, the count includes web users',()=>{
  const h=harness(),find=h.ppl.querySelector('.rmd-find');assert.ok(find);find.value='wil';find.dispatchEvent(new Event('input'));
  assert.deepEqual(h.doc.getElementById('rmPeople').children.map(li=>li.hidden),[true,false,true]);
  const info=h.ppl.querySelector('.rmd-info');assert.match(info.title,/participant list/);assert.ok(h.doc.getElementById('rmListNote').classList.contains('ds-sr-only'));
  const d=F.initial();d.web=[{web:true,display:'quill-fable',patv:{username:'quill-fable'}}];h.controller.update(d);assert.equal(h.doc.getElementById('rmPplN').textContent,'7');
});
test('privacy updates dismiss the original person menu without dismissing it on ordinary polls',()=>{
  let h,closed=0;const mod={closeMenu(refocus){assert.equal(refocus,false);closed++;const p=h.doc.querySelector('.pm-pop');if(p)p.remove();}};
  h=harness({opts:{mod}});
  const open=login=>{const p=h.make('div','pm-pop',null,h.doc.body,'Named person');p._login=login;return p;};
  const first=F.initial(),login=first.members[0].login;
  let menu=open(login);h.controller.update(F.initial());assert.equal(closed,0);assert.equal(menu.isConnected,true);
  const veiled=F.initial();veiled.members[0]={anon:true,veil:'hidden',alias:'Moonlit Froglet'};h.controller.update(veiled);
  assert.equal(closed,1);assert.equal(menu.isConnected,false);
  menu=open('former-member');h.controller.update(F.initial());assert.equal(closed,1);assert.equal(menu.isConnected,true);
  const removed=F.initial();removed.removed=['line-42'];h.controller.update(removed);assert.equal(closed,2);assert.equal(menu.isConnected,false);
  menu=open('former-member');const redo=F.initial();redo.redo=[{c:'line-43',u:{anon:true,veil:'hidden'}}];h.controller.update(redo);
  assert.equal(closed,3);assert.equal(menu.isConnected,false);h.controller.destroy();
});
test('a pending native video PiP request cannot survive a source change or a redock',async()=>{
  for(const change of ['source','redock','leave-live']){
    let selection={stream:'fixture-own-stream',embed:false},resolve,exits=0;
    const h=harness({opts:{stage:{selection:()=>selection,view:()=>selection.stream}}}),video=h.stage.querySelector('video');
    video.requestPictureInPicture=()=>new Promise(done=>{resolve=()=>{h.doc.pictureInPictureElement=video;done();};});
    h.doc.exitPictureInPicture=()=>{exits++;h.doc.pictureInPictureElement=null;return Promise.resolve();};
    h.menuPick('Stage options','Pop out player');assert.equal(typeof resolve,'function');
    if(change==='source'){selection={stream:'mic',embed:false};h.controller.stageChanged(selection);}
    else if(change==='redock')h.controller.redock();
    else{h.panel.hidden=true;h.doc.dispatchEvent(new Event('patv:padtab',{detail:{tab:'feed'}}));}
    resolve();await flush();assert.equal(exits,1,change+' closes the late native PiP');assert.equal(h.doc.pictureInPictureElement,null);
    h.controller.destroy();
  }
});
test('ordinary player transport buttons stay usable in fullscreen and Document PiP',async()=>{
  const h=harness({pip:true});let plays=0;
  const play=h.make('button','vjs-play-control',null,h.doc.getElementById('rmVideo'),'Play');play.addEventListener('click',()=>plays++);
  h.button('Fullscreen',h.stage).click();await flush();const full=h.doc.fullscreenElement;play.click();await flush();
  assert.equal(h.doc.fullscreenElement===full,true);assert.equal(plays,1);
  h.controller.redock();h.menuPick('Stage options','Pop out player');await flush();play.click();
  assert.equal(plays,2);assert.equal(h.pipDoc.querySelector('.rmd-toast'),null);h.controller.destroy();
});
test('the pad menu: Feed / About tabs, Share, the Stage group (go live, book, boost sheet), More and Owner items',()=>{
  const h=harness({schedule:true,owner:true}),chip=h.stage.querySelector('.rmd-ov-top .rmd-chip');let shares=0;
  h.doc.addEventListener('click',e=>{if(e.target.closest('[data-share-path]'))shares++;});
  chip.click();let m=menuOf(h.doc);assert.ok(m.querySelector('.hd-follow'),'Follow sits in the menu header on Live');
  const text=m.textContent;for(const w of ['Feed','About','Share pad','Go live here','Book a slot','Boost this pad…','Rules','Manage your pad','Settings'])assert.match(text,new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),w);
  assert.doesNotMatch(text,/Copy link/,'one Share, not two');assert.match(text,/1\/2 slots in use/);assert.match(text,/2 waiting/);
  assert.equal(m.querySelectorAll('a').find(a=>a.textContent.includes('Go live here')).getAttribute('href'),'/stage?room=night-orchard');
  h.button('Feed',m).click();assert.deepEqual(h.calls.clicks.filter(x=>x.startsWith('tab:')),['tab:feed']);assert.ok(h.hero.querySelector('.hd-follow'),'Follow goes back to the header');
  chip.click();h.button('Share pad',menuOf(h.doc)).click();assert.equal(shares,1);
  chip.click();h.button('Rules',menuOf(h.doc)).click();assert.ok(h.calls.clicks.includes('rules'),'a tab link is clicked, not followed');
  chip.click();h.button('Boost this pad…',menuOf(h.doc)).click();const box=h.doc.getElementById('rmBoostBox');assert.ok(h.doc.querySelector('.rmd-layer').contains(box));assert.equal(box.hidden,false);
  h.button('Close').click();assert.equal(box.hidden,true);assert.equal(box.parentNode===h.doc.getElementById('rmGoLive'),true);
});
test('stage schedule: a sheet from the stage ⋯ that never leaves the pad document',async()=>{
  const h=harness({pip:true,schedule:true}),schedule=h.doc.getElementById('rmSched'),home=schedule.parentNode;
  h.menuPick('Stage options','Stage schedule…');assert.equal(h.doc.querySelector('.rmd-layer').contains(schedule),true);h.button('Close').click();assert.equal(schedule.parentNode===home,true);
  h.menuPick('Stage options','Pop out player');await flush();h.button('Stage options',h.pipDoc).click();h.button('Stage schedule…',menuOf(h.pipDoc)).click();
  assert.equal(h.doc.getElementById('rmSched')===schedule,true);assert.equal(schedule.parentNode===home,true);assert.equal(h.pipDoc.querySelector('#rmSched'),null);
  assert.equal(h.calls.focus,1);assert.match(h.pipDoc.querySelector('.rmd-toast').textContent,/pad tab/);h.controller.destroy();
});
test('the chat ⋯: jump to a date and ⬇ download proxy their originals; the 📜 chip is an info link',()=>{
  const h=harness();h.button('Chat options').click();const m=menuOf(h.doc);
  assert.match(m.textContent,/Visitors read: 24 h 🔍 · how it works/);assert.equal(m.querySelector('a[href="/privacy#rooms"]')!==null,true);
  h.button('Download chat log…',m).click();assert.deepEqual(h.calls.dl,['dl']);
  h.menuPick('Chat options','Jump to a date');assert.deepEqual(h.calls.clicks.filter(x=>x==='jump-date'),['jump-date']);
});
test('⚔️ Duel from the person menu: a named Camfrog member only; the stake sheet sends !duel <login> <amount>',()=>{
  const h=harness(),d=F.initial(),aster=d.members[0];
  assert.deepEqual(JSON.parse(JSON.stringify(h.controller.pvpFor(aster))),{duel:true,brawl:false});
  assert.equal(h.controller.pvpFor(d.members[2]),null,'never a veiled person');assert.equal(h.controller.pvpFor({...aster,web:true}),null,'never a web line');
  assert.equal(h.controller.pvpFor({login:'gone_fable',display:'Gone'}),null,'only someone in the room now');assert.equal(h.controller.pvpFor({...aster,bot:true}),null);
  h.controller.pvp(aster,'duel',h.input);const sheet=h.doc.querySelector('.rmd-pvp');assert.match(h.doc.querySelector('.rmd-layer').textContent,/Duel Aster Fable/);
  h.button('25,000',sheet).click();sheet.dispatchEvent(new Event('submit'));assert.deepEqual(h.calls.send,['!duel aster_fable 25000']);
  h.controller.pvp(aster,'duel',h.input);const s2=h.doc.querySelector('.rmd-pvp');s2.querySelector('input').value='nope';s2.dispatchEvent(new Event('submit'));assert.equal(h.calls.send.length,1);assert.match(s2.textContent,/Type an amount/);
  s2.querySelector('input').value='5k';s2.dispatchEvent(new Event('submit'));assert.deepEqual(h.calls.send.at(-1),'!duel aster_fable 5000');
  h.controller.pvp(aster,'brawl',h.input);assert.equal(h.doc.querySelector('.rmd-pvp'),null,'no !brawl here: no sheet');
});
test('review: the stake sheet says the stake it sends, asks again from a million, and closes only when its person is no longer here',()=>{
  const h=harness(),d=F.initial(),aster=d.members[0];
  h.controller.pvp(aster,'duel',h.input);let s=h.doc.querySelector('.rmd-pvp'),inp=s.querySelector('input'),send=s.querySelectorAll('button').find(b=>/Send challenge/.test(b.getAttribute('aria-label')||''));
  assert.equal(send.getAttribute('aria-label'),'Send challenge · 5,000 PAT');
  inp.value='5m';inp.dispatchEvent(new Event('input'));assert.equal(send.getAttribute('aria-label'),'Send challenge · 5,000,000 PAT','"5m" is spelled out');
  s.dispatchEvent(new Event('submit'));assert.equal(h.calls.send.length,0,'a million or more asks again');assert.match(s.textContent,/press again/);assert.equal(send.getAttribute('aria-label'),'Yes, stake 5,000,000 PAT');
  s.dispatchEvent(new Event('submit'));assert.deepEqual(h.calls.send,['!duel aster_fable 5000000']);
  h.controller.pvp(aster,'duel',h.input);s=h.doc.querySelector('.rmd-pvp');
  const flip=F.initial();flip.members[0]={...flip.members[0],on_cam:!flip.members[0].on_cam,on_mic:true};h.controller.update(flip);assert.ok(h.doc.querySelector('.rmd-pvp'),'a cam / mic flip keeps the sheet');
  const gone=F.initial();gone.members.splice(0,1);h.controller.update(gone);assert.equal(h.doc.querySelector('.rmd-pvp'),null,'they left: the sheet closes');
  h.controller.destroy();
});
test('review: the 💸 Tip sheet keeps its search text across polls and the tool gets focus back when the tip dialog opens',()=>{
  const h=harness(),d=F.initial();d.members.forEach((m,i)=>{if(!m.anon&&m.patv)m.tip={to:m.patv.username,href:'/u/'+m.patv.username+'/tip'};});
  d.web=[{web:true,display:'quill-fable',patv:{username:'quill-fable'},tip:{to:'quill-fable',href:'/u/quill-fable/tip'}},{web:true,display:'fern-fable',patv:{username:'fern-fable'},tip:{to:'fern-fable',href:'/u/fern-fable/tip'}}];
  h.controller.update(d);const tool=h.button('Tip',h.compose.querySelector('.rmd-tools'));tool.click();
  const sheet=h.doc.querySelector('.rmd-layer'),find=sheet.querySelector('.rmd-find');assert.equal(find.hidden,false,'more than four: a search field');
  find.value='quill';find.dispatchEvent(new Event('input'));const kids=()=>sheet.querySelector('.rmd-tip-list').children;
  assert.deepEqual(kids().filter(b=>!b.hidden).map(b=>b._tipTo),['quill-fable']);
  const same=JSON.parse(JSON.stringify(d));h.controller.update(same);assert.equal(h.doc.querySelector('.rmd-layer'),sheet,'a poll keeps the sheet');assert.equal(find.value,'quill');
  const quill=kids().find(b=>b._tipTo==='quill-fable');quill.click();assert.equal(h.doc.activeElement===tool,true,'focus on 💸 when the dialog opens (it returns it there)');assert.equal(h.calls.tip.at(-1).to,'quill-fable');
  h.controller.destroy();
});
test('review: the stage overlay - one source chip node; 🖥️ is a toggle (Exit fullscreen inside it, the viewbar\'s ↩ hidden); the chat heading\'s words are one box',async()=>{
  const h=harness();
  assert.ok(h.chatH.querySelector(':scope > .rmd-chat-t')||h.chatH.children.find(c=>c.classList.contains('rmd-chat-t')),'CHAT in its own span');
  const full=h.stage.querySelectorAll('.rmd-ov-bot button').find(b=>b.getAttribute('aria-label')==='Fullscreen');full.click();await flush();
  assert.equal(full.getAttribute('aria-label'),'Exit fullscreen');const fs=h.doc.querySelector('.rmd-fullscreen');assert.equal(fs.querySelector('[data-rmd-back]').hidden,true,'one way out');
  full.click();await flush();assert.equal(h.doc.querySelector('.rmd-fullscreen'),null);assert.equal(full.getAttribute('aria-label'),'Fullscreen');
  h.menuPick('Stage options','Hide stage');assert.equal(h.doc.activeElement===h.button('Show stage'),true,'focus follows to 📺 Show stage');
  h.button('Show stage').click();assert.equal(h.doc.activeElement===h.button('Stage options'),true,'and back to the stage ⋯');
  h.controller.destroy();
});
test('holder chips are redrawn only when the holders change',()=>{
  const h=harness(),list=F.initial().mic,box=h.doc.querySelector('.rmd-holders'),first=box.children[0],calls=h.calls.avatar;
  h.controller.mic(JSON.parse(JSON.stringify(list)));h.controller.mic(JSON.parse(JSON.stringify(list)));
  assert.ok(box.children[0]===first,'same chip node');assert.equal(h.calls.avatar,calls,'no second render');
  h.controller.mic(list.slice(0,1));assert.ok(box.children[0]!==first,'rebuilt');assert.equal(box.children.length,1);
  h.controller.mic([]);assert.equal(box.hidden,true);
});
test('floating the chat again and again leaves no stale window listeners',()=>{
  const h=harness(),count=()=>(h.win.listeners.resize||[]).length,base=count();
  for(let i=0;i<4;i++){h.menuPick('Chat options','Float chat');assert.ok(h.chat.closest('.rmd-float'));h.controller.redock();}
  assert.equal(count(),base,'resize listeners after 4 floats');
  h.menuPick('Chat options','Float chat');assert.equal(count(),base+1);h.controller.redock();assert.equal(count(),base);
});
// owner decision 6: the controls are emoji icons; the words stay the button's accessible name and tooltip
test('controls are emoji icons with their words as accessible names',()=>{
  const h=harness({pip:true}),icon=b=>b.querySelector('.ds-ic');
  const want={'Fullscreen':'🖥️','Stage options':'⋯','Chat options':'⋯','Audio settings':'🎚️','Tip':'💸','Chat apps':'⚡','Pepe says it':'🗣️','Soundboard':'🔊','Add to the chat':'＋','Cam options':'⋯'};
  for(const [label,emoji] of Object.entries(want)){
    const b=h.button(label);assert.equal(icon(b).textContent,emoji,label);assert.equal(icon(b).getAttribute('aria-hidden'),'true',label);
    assert.equal(b.getAttribute('aria-label'),label);assert.equal(b.title,label);assert.equal(b.querySelector('.rmd-label').textContent,label);
  }
  const old=/[▁⌄⛶↗\u{1F5D7}]|↩(?!️)/u;
  const all=()=>h.doc.querySelectorAll('button').map(b=>icon(b)?icon(b).textContent:'').join(' ');
  assert.doesNotMatch(all(),old,'no text-symbol icon at rest');
  h.menuPick('Chat options','Float chat');const back=h.root.querySelectorAll('button').filter(b=>b.getAttribute('aria-label')==='Bring it back');
  assert.ok(back.length>=2);for(const b of back)assert.equal(icon(b).textContent,'↩️');assert.doesNotMatch(all(),old,'no text-symbol icon while floating');
  h.controller.redock();h.menuPick('Cam options','Watch on my stage');assert.equal(icon(h.button('Return cam to strip')).textContent,'↩️');
  assert.doesNotMatch(all(),old,'no text-symbol icon on a local cam');
});
// 1.99ajc dockfu (design call e): Escape still redocks - a Dock sheet open over it takes the first Escape, the next one redocks
test('Escape closes a Dock sheet first, then redocks the floating chat',()=>{
  const h=harness(),opener=h.button('Chat options');opener.focus();h.menuPick('Chat options','Float chat');assert.ok(h.chat.closest('.rmd-float'));
  h.button('Pepe says it').click();assert.ok(h.doc.querySelector('.rmd-tts'));
  h.doc.dispatchEvent(new Event('keydown',{key:'Escape'}));assert.equal(h.doc.querySelector('.rmd-tts'),null,'the sheet closes');assert.ok(h.chat.closest('.rmd-float'),'the chat still floats');
  h.doc.dispatchEvent(new Event('keydown',{key:'Escape'}));assert.equal(h.chat.closest('.rmd-float'),null,'Escape redocks');
  assert.equal(h.doc.querySelectorAll('#rmFeed').length,1);
});
