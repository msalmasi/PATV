"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {harness,Event}=require('./fixtures/pad-dock/dom.cjs');
const F=require('./fixtures/pad-dock/room.cjs');
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
test('Live framing follows the actual tab; mobile drawer only folds the pad header',()=>{
  const h=harness();assert.equal(h.doc.body.classList.contains('pad-dock-live'),true);
  const handle=h.button('Pad header and tabs');assert.equal(handle.getAttribute('aria-expanded'),'false');handle.click();assert.equal(handle.getAttribute('aria-expanded'),'true');assert.equal(h.root.classList.contains('rmd-drawer-open'),true);assert.equal(h.drawer.contains(h.header),false);
  for(const tab of ['feed','about','live']){h.doc.dispatchEvent(new Event('patv:padtab',{detail:{tab}}));assert.equal(h.doc.body.classList.contains('pad-dock-live'),tab==='live');}
  h.controller.destroy();assert.equal(h.doc.body.classList.contains('pad-dock-live'),false);assert.equal(harness({feed:true}).doc.body.classList.contains('pad-dock-live'),false);
});
test('float, fullscreen and redock move the same feed and preserve privacy markup',async()=>{
  const h=harness(),same=h.feed,before=h.feed.outerHTML,story=h.story;h.button('Float chat').click();
  assert.ok(h.chat.closest('.rmd-float'));assert.ok(h.root.contains(h.chat));assert.equal(h.doc.getElementById('rmFeed'),same);assert.equal(h.feed.outerHTML,before);assert.equal(story.ownerDocument,h.doc);assert.equal(h.chat.contains(story),false);
  h.controller.redock();assert.equal(h.chat.closest('.rmd-float'),null);assert.equal(h.doc.querySelectorAll('#rmFeed').length,1);
  h.button('Fullscreen',h.stage).click();await flush();assert.ok(h.root.contains(h.doc.fullscreenElement));h.button('Show chat').click();assert.ok(h.chat.closest('.rmd-overlay'));assert.equal(h.doc.getElementById('rmFeed'),same);assert.equal(h.feed.outerHTML,before);assert.equal(h.chat.contains(story),false);
  h.button('Show chat').click();assert.equal(h.chat.closest('.rmd-overlay'),null);h.controller.redock();assert.equal(h.doc.getElementById('rmFeed'),same);assert.equal(h.doc.querySelectorAll('#rmPtt').length,1);
});
test('Document PiP adopts one log, exact pad identity and all stylesheets; close restores it',async()=>{
  const h=harness({pip:true}),before=h.feed.outerHTML,styles=h.doc.querySelectorAll('link[rel="stylesheet"],style').length;
  h.button('Pop out chat').click();await flush();const p=h.pipDoc,main=p.querySelector('main');
  assert.equal(p.getElementById('rmFeed'),h.feed);assert.equal(h.doc.getElementById('rmFeed'),null);assert.equal(h.feed.outerHTML,before);assert.equal(main.className,h.root.className);assert.equal(main.getAttribute('style'),h.root.getAttribute('style'));assert.equal(p.querySelectorAll('link[rel="stylesheet"],style').length,styles);assert.equal(p.querySelector('.rm-story'),null);
  h.doc.hidden=true;assert.equal(h.controller.visible(),true);p.hidden=true;assert.equal(h.controller.visible(),false);p.hidden=false;
  h.button('Add to the chat',p).click();assert.ok(p.querySelector('.rmd-menu'));assert.equal(p.querySelectorAll('button').some(b=>b.textContent.includes('Add to your story')),false);
  h.button('Pepe says it',p.querySelector('.rmd-menu')).click();assert.ok(p.querySelector('.rmd-tts'));assert.equal(h.doc.querySelector('.rmd-tts'),null);
  h.pipWin.close();assert.equal(h.doc.getElementById('rmFeed'),h.feed);assert.equal(h.doc.querySelectorAll('#rmFeed').length,1);assert.equal(h.feed.outerHTML,before);assert.ok(h.calls.adopt.includes(p));assert.equal(h.calls.adopt.at(-1),h.doc);
});
test('topmost foreign dialogs own Escape and focus before the floating Dock',()=>{
  const h=harness();h.button('Float chat').click();const float=h.chat.closest('.rmd-float');
  const modal=h.make('div',null,null,h.doc.body);modal.setAttribute('aria-modal','true');const field=h.make('input',null,null,modal);field.focus();
  h.doc.dispatchEvent(new Event('keydown',{key:'Escape'}));assert.equal(h.chat.closest('.rmd-float'),float);assert.equal(h.doc.activeElement,field);
  modal.remove();h.doc.dispatchEvent(new Event('keydown',{key:'Escape'}));assert.equal(h.chat.closest('.rmd-float'),null);
});
test('extras, TTS and Apps share the relay; availability updates never send an action',()=>{
  const h=harness();assert.equal(h.input.maxLength,300);assert.equal(h.ptt.closest('form'),null);assert.equal(h.input.closest('.rmd-input-row'),h.ptt.parentNode);assert.equal(h.send.closest('.rmd-input-row'),h.ptt.parentNode);
  h.button('Pepe says it').click();let sheet=h.doc.querySelector('.rmd-tts');assert.match(sheet.textContent,/100 PAT/);sheet.querySelector('input').value='A quiet hello';sheet.dispatchEvent(new Event('submit'));assert.deepEqual(h.calls.send,['!say A quiet hello']);
  h.button('Chat apps').click();let apps=h.doc.querySelector('.rmd-layer');assert.match(apps.textContent,/!duel/);assert.match(apps.textContent,/!bj/);assert.doesNotMatch(apps.textContent,/!brawl|!holdem/);h.button('⚔️!duel',apps).click();assert.equal(h.input.value,'!duel ');assert.equal(h.calls.send.length,1);
  const d=F.initial();delete d.room.cmds['!say'];h.controller.update(d);assert.equal(h.root.querySelector('[data-rmd-tts]').hidden,true);h.button('Add to the chat').click();assert.doesNotMatch(h.doc.querySelector('.rmd-menu').textContent,/Pepe says it/);
  assert.equal(h.doc.querySelectorAll('button').some(b=>/GIF|sticker|emoji/i.test(b.textContent)),false);
});
test('soundboard and story entry use the originals and restore soundboard on close',()=>{
  const h=harness(),parent=h.sb.parentNode;h.button('Soundboard',h.compose.querySelector('.rmd-composer-tools')).click();assert.ok(h.doc.querySelector('.rmd-layer').contains(h.sb));assert.equal(h.doc.querySelectorAll('#rmSb').length,1);assert.equal(h.sb.querySelector('.sbd-toggle').getAttribute('aria-expanded'),'true');h.button('Close').click();assert.equal(h.sb.parentNode,parent);
  h.button('Add to the chat').click();h.button('Add to your story',h.doc.querySelector('.rmd-menu')).click();assert.equal(h.calls.story,1);assert.equal(h.story.ownerDocument,h.doc);
});
test('holder chips use shared rendering and veiled people have no actionable identity',()=>{
  const h=harness(),holders=h.doc.querySelector('.rmd-holders');assert.equal(h.calls.avatar,2);assert.equal(h.calls.name,2);assert.match(holders.textContent,/Misty Froglet/);
  const veiled=holders.children[1];assert.doesNotMatch(veiled.outerHTML,/opaque-cam|data-u|href=/);assert.equal(veiled.querySelector('a,button,[role="button"]'),null);assert.equal(veiled.querySelector('.cam'),null);
  const normal=holders.children[0].querySelector('.who');normal.click();assert.equal(h.calls.person.length,1);normal.dispatchEvent(new Event('click',{ctrlKey:true}));assert.equal(h.calls.person.length,1);
  for(const line of h.feed.querySelectorAll('.line[data-vc]')){assert.equal(line.getAttribute('data-c'),null);assert.equal(line.getAttribute('data-text'),null);}
});
test('private camera swap, hide and source changes preserve the original players',()=>{
  const h=harness(),tile=h.tile,video=tile.querySelector('video');h.button('Watch on my stage').click();assert.equal(h.root.classList.contains('rmd-local-cam'),true);assert.equal(h.doc.querySelector('.rmd-local-player .cs-tile'),tile);assert.equal(tile.querySelector('video'),video);assert.equal(h.strip.querySelector('.cs-tile'),null);h.button('Return cam to strip').click();assert.equal(h.strip.querySelector('.cs-tile'),tile);
  h.button('Hide stage').click();assert.equal(h.root.classList.contains('rmd-stage-hidden'),true);assert.equal(h.doc.getElementById('rmdMini').hidden,false);h.button('Show stage').click();assert.equal(h.root.classList.contains('rmd-stage-hidden'),false);
  h.button('Pop out player').click();assert.match(h.doc.querySelector('.rmd-toast').textContent,/unavailable/);assert.equal(h.stage.querySelector('video').ownerDocument,h.doc);
});
test('fullscreen body-attached controls leave fullscreen before replay; PiP controls focus pad',async()=>{
  const h=harness({pip:true}),line=h.feed.querySelector('.line'),action=h.make('button','la-btn',null,line,'Line actions');let invoked=0;action.addEventListener('click',()=>invoked++);
  h.button('Fullscreen',h.stage).click();h.button('Show chat').click();action.click();await flush();assert.equal(h.doc.fullscreenElement,null);assert.equal(invoked,1);assert.equal(h.doc.getElementById('rmFeed'),h.feed);
  h.button('Pop out chat').click();await flush();action.click();assert.equal(invoked,1);assert.equal(h.calls.focus,1);assert.match(h.pipDoc.querySelector('.rmd-toast').textContent,/pad tab/);
});
test('recording-time duck delegates to the shared audio object and survives moves',()=>{
  const h=harness();h.button('Duck while recording').click();assert.equal(h.button('Duck while recording').getAttribute('aria-pressed'),'true');h.calls.recordFn(true);h.calls.recordFn(false);assert.deepEqual(h.calls.record,[true,false]);h.button('Float chat').click();h.calls.recordFn(true);assert.deepEqual(h.calls.record,[true,false,true]);h.controller.redock();assert.equal(h.doc.querySelectorAll('#rmAudioBox').length,1);
});
test('a disabled text relay cannot hide a separately enabled mic relay',()=>{
  const h=harness(),form=h.input.closest('form');form.classList.add('hide');assert.equal(h.ptt.closest('.hide'),null);assert.equal(h.ptt.closest('form'),null);assert.equal(h.ptt.getClientRects().length,1);assert.equal(h.doc.querySelectorAll('#rmPtt').length,1);
});
test('a late Document PiP result after leaving Live closes without moving chat',async()=>{
  const h=harness({pip:true,deferPiP:true}),before=h.feed.outerHTML;h.button('Pop out chat').click();h.panel.hidden=true;h.doc.dispatchEvent(new Event('patv:padtab',{detail:{tab:'feed'}}));h.resolvePip();await flush();assert.equal(h.pipWin.closed,true);assert.equal(h.doc.getElementById('rmFeed'),h.feed);assert.equal(h.feed.outerHTML,before);assert.equal(h.doc.body.classList.contains('pad-dock-live'),false);
});

test('a live veil change closes the named tip picker and invalidates its previously rendered recipient action',()=>{
  const h=harness(),d=F.initial();
  d.members[0].tip={to:'aster-fable',href:'/u/aster-fable'};h.controller.update(d);
  const open=()=>{h.button('Add to the chat').click();h.button('Tip',h.doc.querySelector('.rmd-menu')).click();};
  open();let picker=h.doc.querySelector('.rmd-layer');
  assert.match(picker.textContent,/Aster Fable/);
  const stale=picker.querySelectorAll('button').find(b=>b.textContent==='Aster Fable');assert.ok(stale);
  d.members[0]={anon:true,veil:'hidden',alias:'Moonlit Froglet',hood:2};h.controller.update(d);
  assert.equal(!!h.doc.querySelector('.rmd-layer'),false,'privacy updates remove the recipient snapshot at once');
  stale.click();assert.equal(h.calls.tip.length,0,'a queued activation cannot use the old named identity');
  open();picker=h.doc.querySelector('.rmd-layer');assert.doesNotMatch(picker.textContent,/Aster Fable/);assert.match(picker.textContent,/No eligible recipients/);
  h.button('Close').click();
  const again=F.initial();again.members[0].tip={to:'aster-fable',href:'/u/aster-fable'};h.controller.update(again);open();
  h.doc.querySelector('.rmd-layer').querySelectorAll('button').find(b=>b.textContent==='Aster Fable').click();
  assert.equal(h.calls.tip.length,1);assert.equal(h.calls.tip[0].to,'aster-fable');assert.equal(h.calls.tip[0].display,'Aster Fable');
  h.controller.destroy();
});

test('sheets opened through the extras menu restore focus to the connected extras button in both documents',async()=>{
  for(const pip of [false,true]){
    const h=harness({pip});
    if(pip){h.button('Pop out chat').click();await flush();}
    const doc=pip?h.pipDoc:h.doc,opener=h.button('Add to the chat',doc);
    for(const label of ['Pepe says it','Chat apps','Soundboard'].concat(pip?[]:['Tip'])){
      opener.focus();opener.click();const removedMenuItem=h.button(label,doc.querySelector('.rmd-menu'));removedMenuItem.click();
      assert.equal(removedMenuItem.isConnected,false,'the menu closes before opening its sheet');
      assert.ok(doc.querySelector('.rmd-layer'));h.button('Close',doc.querySelector('.rmd-layer')).click();
      assert.equal(doc.activeElement===opener,true,label+' returns focus to extras');assert.equal(doc.activeElement.isConnected,true);
    }
    h.controller.destroy();
  }
});

test('a camera watched on the local stage keeps reachable hide, restore and pop-out controls without creating a second player',async()=>{
  const h=harness({pip:true}),tile=h.tile,video=tile.querySelector('video');
  h.button('Watch on my stage').click();const local=h.doc.querySelector('.rmd-local-player');
  h.button('Hide stage',local).click();assert.equal(h.root.classList.contains('rmd-stage-hidden'),true);assert.equal(h.doc.getElementById('rmdMini').hidden,false);
  h.button('Show stage').click();assert.equal(h.root.classList.contains('rmd-stage-hidden'),false);assert.equal(local.contains(tile),true);
  h.button('Pop out player',local).click();await flush();
  assert.equal(h.pipDoc.querySelector('.rmd-local-player')===local,true);assert.equal(h.pipDoc.querySelector('.cs-tile')===tile,true);
  assert.equal(tile.querySelector('video')===video,true);assert.equal(h.doc.querySelectorAll('.cs-tile').length,0);
  h.pipWin.close();assert.equal(h.doc.querySelector('.rmd-local-player')===local,true);assert.equal(local.contains(tile),true);
  h.button('Return cam to strip').click();assert.equal(h.strip.querySelector('.cs-tile')===tile,true);assert.equal(h.doc.querySelectorAll('.cs-tile').length,1);assert.equal(tile.querySelector('video')===video,true);
  h.controller.destroy();
});

test('extras menus support arrows, Home, End and Escape in the pad and PiP documents',async()=>{
  for(const pip of [false,true]){
    const h=harness({pip});if(pip){h.button('Pop out chat').click();await flush();}
    const doc=pip?h.pipDoc:h.doc,opener=h.button('Add to the chat',doc);opener.click();
    const menu=doc.querySelector('.rmd-menu'),items=menu.querySelectorAll('[role="menuitem"]');assert.ok(items.length>=3);
    assert.equal(doc.activeElement===items[0],true,'opening a menu focuses its first action');
    const key=(key,index)=>{const e=new Event('keydown',{key});doc.dispatchEvent(e);assert.equal(e.defaultPrevented,true);assert.equal(doc.activeElement===items[index],true,key+' focuses the expected action');};
    key('ArrowDown',1);key('End',items.length-1);key('ArrowDown',0);key('ArrowUp',items.length-1);key('Home',0);
    items[1].disabled=true;key('ArrowDown',2);items[1].disabled=false;
    doc.dispatchEvent(new Event('keydown',{key:'Escape'}));assert.equal(menu.isConnected,false);assert.equal(doc.activeElement===opener,true);
    h.controller.destroy();
  }
});

test('Dock notices reuse the body toast stack and remain inside fullscreen and PiP surfaces',async()=>{
  const h=harness({pip:true}),stack=h.make('div','ds-toasts',null,h.doc.body),existing=h.make('div','ds-toast',null,stack,'Existing notice');
  // The mic stage does not support a plain video pop-out without Document PiP.
  const plain=harness(),plainStack=plain.make('div','ds-toasts',null,plain.doc.body),plainNotice=plain.make('div','ds-toast',null,plainStack,'Existing notice');
  plain.button('Pop out player').click();const first=plain.doc.querySelector('.rmd-toast');
  assert.equal(first.parentNode===plainStack,true);assert.equal(plain.root.contains(first),false);assert.equal(plainNotice.isConnected,true);
  plain.button('Pop out player').click();assert.equal(first.isConnected,false);assert.equal(plain.doc.querySelectorAll('.ds-toasts').length,1);assert.equal(plain.doc.querySelectorAll('.rmd-toast').length,1);
  const action=h.make('button','la-btn',null,h.feed.querySelector('.line'),'Line actions');
  h.button('Fullscreen',h.stage).click();await flush();h.button('Show chat').click();const full=h.doc.fullscreenElement;
  const exit=h.doc.exitFullscreen.bind(h.doc);h.doc.exitFullscreen=()=>Promise.reject(new Error('Fullscreen exit refused'));
  action.click();await flush();assert.equal(h.doc.fullscreenElement===full,true);assert.equal(full.querySelector('.rmd-toast').closest('.ds-toasts').parentNode===full,true);assert.equal(existing.isConnected,true);
  h.doc.exitFullscreen=exit;await exit();h.controller.redock();h.button('Pop out chat').click();await flush();action.click();
  const notice=h.pipDoc.querySelector('.rmd-toast');assert.equal(notice.closest('.ds-toasts').parentNode===h.pipDoc.querySelector('main'),true);assert.equal(h.doc.querySelectorAll('.ds-toasts').length,1);
  plain.controller.destroy();h.controller.destroy();
});

test('the topic and its inline edit button obey the current permission for pointer and keyboard input',()=>{
  let allowed=true;const h=harness({opts:{canTopic:()=>allowed}}),topic=h.doc.getElementById('rmTopic'),edit=h.button('Edit topic');
  assert.equal(topic.parentNode===edit.parentNode,true);assert.equal(topic.parentNode.classList.contains('rmd-topic-line'),true);
  assert.equal(topic.getAttribute('role'),'button');assert.equal(topic.tabIndex,0);assert.equal(edit.hidden,false);
  topic.click();assert.equal(h.calls.topic,1);h.button('Close').click();
  topic.dispatchEvent(new Event('keydown',{key:'Enter'}));assert.equal(h.calls.topic,2);h.button('Close').click();
  allowed=false;h.controller.update(F.initial());assert.equal(edit.hidden,true);assert.equal(topic.getAttribute('role'),null);assert.equal(topic.getAttribute('tabindex'),null);
  topic.click();topic.dispatchEvent(new Event('keydown',{key:' '}));edit.click();assert.equal(h.calls.topic,2,'a stale activation rechecks permission');
  allowed=true;h.controller.update(F.initial());edit.click();assert.equal(h.calls.topic,3);h.controller.destroy();
});

test('Participants restores roster anchors before existing person and camera popovers open',()=>{
  const h=harness(),home=h.side.parentNode,icons=h.make('span','ic',null,h.side);
  for(const [cls,parent] of [['pm-mg',h.side],['cam',icons]]){
    const trigger=h.make('button',cls,null,parent,'Existing action');let panel,field,restoredAtOpen=false;
    trigger.addEventListener('click',()=>{
      restoredAtOpen=h.side.parentNode===home;
      panel=h.make('div',cls==='cam'?'snap':'pm-pop',null,h.doc.body);panel.setAttribute('role','dialog');
      field=h.make('button',null,null,panel,'Existing popover action');field.focus();
    });
    h.button('Participants').click();trigger.click();
    assert.equal(restoredAtOpen,true);assert.equal(trigger.isConnected,true);assert.equal(h.doc.querySelector('.rmd-layer'),null);
    assert.equal(h.doc.activeElement===field,true,'the dismissed Participants trap does not steal popover focus');panel.remove();
  }
  h.button('Participants').click();const edit=h.make('button','pm-btn',null,h.side,'Edit topic');let editing=false;
  edit.addEventListener('click',()=>{editing=true;});edit.click();assert.equal(editing,true);assert.ok(h.doc.querySelector('.rmd-layer'),'inline topic actions keep the sheet open');
  h.controller.destroy();
});

test('privacy updates dismiss the original person menu without dismissing it on ordinary polls',()=>{
  let h,closed=0;const mod={closeMenu(refocus){assert.equal(refocus,false);closed++;const p=h.doc.querySelector('.pm-pop');if(p)p.remove();}};
  h=harness({opts:{mod}});
  const open=login=>{const p=h.make('div','pm-pop',null,h.doc.body,'Named person');p._login=login;return p;};
  const first=F.initial(),login=first.members[0].login;
  let menu=open(login);h.controller.update(F.initial());assert.equal(closed,0);assert.equal(menu.isConnected,true);
  const veiled=F.initial();veiled.members[0]={anon:true,veil:'hidden',alias:'Moonlit Froglet'};h.controller.update(veiled);
  assert.equal(closed,1);assert.equal(menu.isConnected,false);
  // A historical author absent from the current room is still usable until its line changes.
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
    h.button('Pop out player').click();assert.equal(typeof resolve,'function');
    if(change==='source'){selection={stream:'mic',embed:false};h.controller.stageChanged(selection);}
    else if(change==='redock')h.controller.redock();
    else{h.panel.hidden=true;h.doc.dispatchEvent(new Event('patv:padtab',{detail:{tab:'feed'}}));}
    resolve();await flush();assert.equal(exits,1,change+' closes the late native PiP');assert.equal(h.doc.pictureInPictureElement,null);
    h.controller.destroy();
  }
  let exits=0;const h=harness({opts:{stage:{selection:()=>({stream:'fixture-own-stream'}),view:()=> 'fixture-own-stream'}}}),video=h.stage.querySelector('video');
  video.requestPictureInPicture=()=>{h.doc.pictureInPictureElement=video;return Promise.resolve();};
  h.doc.exitPictureInPicture=()=>{exits++;h.doc.pictureInPictureElement=null;return Promise.resolve();};
  h.button('Pop out player').click();await flush();assert.equal(exits,0);h.controller.redock();assert.equal(exits,1);h.controller.destroy();
});

test('ordinary player transport buttons stay usable in fullscreen and Document PiP',async()=>{
  const h=harness({pip:true});let plays=0;
  const play=h.make('button','vjs-play-control',null,h.doc.getElementById('rmVideo'),'Play');play.addEventListener('click',()=>plays++);
  h.button('Fullscreen',h.stage).click();await flush();const full=h.doc.fullscreenElement;play.click();await flush();
  assert.equal(h.doc.fullscreenElement===full,true);assert.equal(plays,1);
  h.controller.redock();h.button('Pop out player').click();await flush();play.click();
  assert.equal(plays,2);assert.equal(h.pipDoc.querySelector('.rmd-toast'),null);h.controller.destroy();
});

test('stage Share leaves fullscreen for its original handler and directs PiP users to the pad',async()=>{
  const h=harness({pip:true}),share=h.make('button',null,null,h.stage,'Share');share.setAttribute('data-share-path','/p/fixture');let shares=0;
  h.doc.addEventListener('click',e=>{if(e.target.closest('[data-share-path]'))shares++;});
  h.button('Fullscreen',h.stage).click();await flush();share.click();await flush();
  assert.equal(h.doc.fullscreenElement,null);assert.equal(shares,1);
  h.button('Pop out player').click();await flush();share.click();assert.equal(shares,1);assert.equal(h.calls.focus,1);
  assert.match(h.pipDoc.querySelector('.rmd-toast').textContent,/pad tab/);h.controller.destroy();
});

test('stage status stays outside the aside and its schedule never leaves the pad document',async()=>{
  const h=harness({pip:true,schedule:true}),schedule=h.doc.getElementById('rmSched'),slots=h.doc.getElementById('rmSlotsTxt');
  const status=schedule.closest('.rmd-stage-status');assert.ok(status);assert.equal(status.parentNode===h.panel,true);assert.equal(status.contains(slots),true);assert.equal(h.side.contains(status),false);
  h.button('Stage schedule').click();assert.equal(h.doc.querySelector('.rmd-layer').contains(schedule),true);h.button('Close').click();assert.equal(schedule.parentNode===status,true);
  h.button('Pop out player').click();await flush();h.button('Stage schedule',h.pipDoc).click();
  assert.equal(h.doc.getElementById('rmSched')===schedule,true);assert.equal(schedule.parentNode===status,true);assert.equal(h.pipDoc.querySelector('#rmSched'),null);
  assert.equal(h.calls.focus,1);assert.match(h.pipDoc.querySelector('.rmd-toast').textContent,/pad tab/);h.controller.destroy();
});
// 1.99aiw dock review: drawMic runs on every /live answer (and on lip-sync redraws) - the holder chips are rebuilt only when the
// holders change, like the On the mic card (a rebuild restarted animated name styles and dropped keyboard focus on a chip)
test('holder chips are redrawn only when the holders change',()=>{
  const h=harness(),list=F.initial().mic,box=h.doc.querySelector('.rmd-holders'),first=box.children[0],calls=h.calls.avatar;
  h.controller.mic(JSON.parse(JSON.stringify(list)));h.controller.mic(JSON.parse(JSON.stringify(list)));
  assert.ok(box.children[0]===first,'same chip node');assert.equal(h.calls.avatar,calls,'no second render');
  h.controller.mic(list.slice(0,1));assert.ok(box.children[0]!==first,'rebuilt');assert.equal(box.children.length,1);
  h.controller.mic([]);assert.equal(box.hidden,true);
});
// 1.99aiw dock review: each float added a window resize listener that outlived its panel (one more per float / redock)
test('floating the chat again and again leaves no stale window listeners',()=>{
  const h=harness(),count=()=>(h.win.listeners.resize||[]).length,base=count();
  for(let i=0;i<4;i++){h.button('Float chat').click();assert.ok(h.chat.closest('.rmd-float'));h.controller.redock();}
  assert.equal(count(),base,'resize listeners after 4 floats');
  h.button('Float chat').click();assert.equal(count(),base+1);h.controller.redock();assert.equal(count(),base);
});

// 1.99?? dockfu (owner decision 6, the lead's design call d): the view controls are emoji icons - 🔽 hide the stage / open the phone
// drawer (🔼 folds it), 🖥️ fullscreen, 🪟 pop out / float, ↩️ bring it back - never the text symbols they were (▁ ⌄ ⛶ ↗ 🗗 ↩). The
// emoji sits in an aria-hidden .ds-ic; the words stay the button's accessible name and tooltip.
test('view controls are emoji icons with their words as accessible names',()=>{
  const h=harness({pip:true}),icon=b=>b.querySelector('.ds-ic');
  const want={'Hide stage':'🔽','Fullscreen':'🖥️','Pop out player':'🪟','Float chat':'🪟','Pop out chat':'🪟','Pad header and tabs':'🔽'};
  for(const [label,emoji] of Object.entries(want)){
    const b=h.button(label);assert.equal(icon(b).textContent,emoji,label);assert.equal(icon(b).getAttribute('aria-hidden'),'true',label);
    assert.equal(b.getAttribute('aria-label'),label);assert.equal(b.title,label);assert.equal(b.querySelector('.rmd-label').textContent,label);
  }
  const old=/[\u2581\u2304\u26f6\u2197\u{1F5D7}]|\u21a9(?!\ufe0f)/u;
  const all=()=>h.doc.querySelectorAll('button').map(b=>icon(b)?icon(b).textContent:'').join(' ');
  assert.doesNotMatch(all(),old,'no text-symbol icon at rest');
  // the drawer handle: 🔽 opens, 🔼 folds back (aria-expanded carries the state)
  const handle=h.button('Pad header and tabs');handle.click();assert.equal(icon(handle).textContent,'🔼');assert.equal(handle.getAttribute('aria-expanded'),'true');
  handle.click();assert.equal(icon(handle).textContent,'🔽');assert.equal(handle.getAttribute('aria-expanded'),'false');
  // the surfaces' own controls: ↩️ bring it back (viewbar + the placeholder left behind), 🖥️ on a cam tile, ↩️ return a cam
  h.button('Float chat').click();const back=h.root.querySelectorAll('button').filter(b=>b.getAttribute('aria-label')==='Bring it back');
  assert.ok(back.length>=2);for(const b of back)assert.equal(icon(b).textContent,'↩️');assert.doesNotMatch(all(),old,'no text-symbol icon while floating');
  h.controller.redock();h.button('Watch on my stage').click();assert.equal(icon(h.button('Return cam to strip')).textContent,'↩️');
  for(const b of h.doc.querySelectorAll('.rmd-local-player button'))if(b.getAttribute('aria-label')==='Fullscreen')assert.equal(icon(b).textContent,'🖥️');
  assert.doesNotMatch(all(),old,'no text-symbol icon on a local cam');
});
// 1.99?? dockfu (design call e): Escape still redocks - the floating chat comes home and focus returns to what opened it; a Dock sheet
// open over it takes the first Escape (it closes), the next one redocks
test('Escape closes a Dock sheet first, then redocks the floating chat',()=>{
  const h=harness(),opener=h.button('Float chat');opener.focus();opener.click();assert.ok(h.chat.closest('.rmd-float'));
  h.button('Pepe says it').click();assert.ok(h.doc.querySelector('.rmd-tts'));
  h.doc.dispatchEvent(new Event('keydown',{key:'Escape'}));assert.equal(h.doc.querySelector('.rmd-tts'),null,'the sheet closes');assert.ok(h.chat.closest('.rmd-float'),'the chat still floats');
  h.doc.dispatchEvent(new Event('keydown',{key:'Escape'}));assert.equal(h.chat.closest('.rmd-float'),null,'Escape redocks');
  assert.equal(h.doc.querySelectorAll('#rmFeed').length,1);assert.equal(h.doc.activeElement,opener,'focus goes back to the opener');
});
