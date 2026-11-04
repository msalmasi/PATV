"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-dock-test-"));
process.chdir(tmp); delete process.env.STAGING; process.env.SECRET_KEY = "fixture-secret"; process.env.PAD_DIR = path.join(tmp, "pad");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "none.m3u8");
const F = require("./fixtures/pad-dock/room.cjs");
const read = p => fs.readFileSync(path.join(repo,p),"utf8").replace(/\r\n/g,"\n");
let seed;
test.before(async () => { seed = await F.seed(); });
const mainTag = h => /<main\b[^>]*>/.exec(h)[0];
const section = (h,id) => { const start = h.indexOf('id="'+id+'"'); assert.ok(start >= 0,id); return h.slice(h.lastIndexOf("<",start),h.indexOf("</section>",start)+10); };

test("Dock is absent when switched off and in every existing non-bridged/gated state", async () => {
  const cases = [
    { padDockOn:false }, { room:{bridged:false},chatHistory:{history:{chat_s:86400}} },
    { room:{siteOnly:true,bridged:false},chatWidget:{state:"mount",mount:{pad:"fixture-pad",room:"fixture-room",mode:"full"}} },
    { room:{bridgeLocked:true} }, { adultGate:"confirm", room:{adult:true} }, { liveOpen:false }
  ];
  for (const extra of cases) {
    const html = await F.render(extra);
    assert.doesNotMatch(mainTag(html), /rm-dock/);
    assert.doesNotMatch(html, /(?:href|src)="\/public\/(?:css|js)\/pad-dock\./);
    assert.doesNotMatch(html, /id="rmd(?:Id|Drawer|Bar)"/);
  }
  assert.match(await F.render(cases[1]),/id="rmHistCard"/);
  assert.match(await F.render(cases[2]),/<patv-chat /);
  assert.match(await F.render(cases[3]),/id="rmPlusLock"/);
});

test("Dock keeps one shell, every bound live id and the original tab panels", async () => {
  const html = await F.render({onairAdmin:true});
  assert.match(mainTag(html),/\brm-dock\b/);
  assert.equal((html.match(/<header>/g)||[]).length,1);
  assert.match(html,/id="navBell"[^>]*href="\/messages\/notices"|href="\/messages\/notices"[^>]*id="navBell"/);
  for(const id of ["rmFeed","rmScroll","rmOlder","rmHistTop","rmHistBot","rmJump","rmClip","rmCompose","rmRelay","rmPtt","rmSb","rmAudioBox","rmTopic","rmStatus","rmHist","rmHistJump","rmSearchBtn","rmMoreBtn","rmMic","rmMicCard","rmPeople","rmPplCard","rmPplN","rmListNote","rmMod","rmStage","rmStageH","rmStPill","rmStPillTxt","rmStReconnect","rmStUnmute","rmEmbed","rmOffTxt","rmTabs","rmVideo","rmCap","rmStrip","rmChat","rmGoLive","rmSlotsTxt","rmBoostBtn","rmBoostBox","rmBoostMsg","rmPlexQ","rmLiveStat","rmStDot","rmCount","rmInit","rmHero","rmTitle","rmMore","rmLive","rmLiveTxt","padTabs","padLaunch","padFeedDot","padFeedNew","oacPromptOn","oaCamRoom"])
    assert.equal((html.match(new RegExp('\\bid="'+id+'"','g'))||[]).length,1,id+" exists once");
  for(const panel of ["live","feed","about"]) assert.match(html,new RegExp('id="padPanel-'+panel+'"'));
  assert.match(html,/id="rmdDrawer"/); assert.match(html,/id="rmdBar"/);
});

test("the standard navbar is the Pads navbar signed in and out",async()=>{
  const ejs=require('ejs');
  const header=html=>html.replace(/\r\n/g,'\n').match(/<header>[\s\S]*?<\/header>/)[0].replace(/\/p\/night-orchard\/submit/g,'/submit').replace(/title="[^"]*"/g,'');
  for(const signedIn of[true,false]){
    const user=signedIn?'viewer-fable':null;
    const guide=await ejs.renderFile(path.join(repo,'views/rooms.ejs'),{user,signedIn,rows:[],owned:[],staff:false,pepe:{active:false},stage:{}});
    assert.equal(header(await F.render({user,signedIn})),header(guide));
  }
});

test("identity partial reuses existing helper results, escapes names and has no duplicate ids", async () => {
  const counts = {look:0,fx:0,av:0};
  const fx = {cls:"pfx fixture-frame",layer:'<span class="pfx-l" aria-hidden="true"></span>',glow:"fixture-glow",badges:'<span class="fixture-full">Full</span>',badgesFit:'<span class="pfx-bs" data-fit>Fit</span>',badgesMini:'<span class="pfx-bs mini" data-fit>Mini</span>'};
  const helpers = {padLook:()=>{counts.look++;return {vars:"--pad-accent:#ff6a9b;--pad-accent-ink:#0b0b0b",accent:"#ff6a9b"};},padFx:()=>{counts.fx++;return fx;},padAv:()=>{counts.av++;return '<span class="pad-av rm-av fixture-avatar"></span>';}};
  await F.render(Object.assign({padDockOn:false},helpers)); const off = {...counts};
  counts.look=counts.fx=counts.av=0;
  const on = await F.render(Object.assign({room:{name:'Orchard <script>alert(1)</script>'}},helpers));
  assert.deepEqual(counts,off,"Dock adds no helper call");
  const tmpl=/<template id="rmdId">([\s\S]*?)<\/template>/.exec(on); assert.ok(tmpl);
  assert.doesNotMatch(tmpl[1],/\bid=/); assert.doesNotMatch(tmpl[1],/<script>/);
  assert.match(tmpl[1],/Orchard &lt;script&gt;/);
  for(const fragment of [fx.cls,fx.layer,fx.glow,fx.badgesMini,'fixture-avatar']) assert.ok(tmpl[1].includes(fragment),fragment);
  assert.match(tmpl[1],/data-fit-name/);
  assert.match(mainTag(on),/style="--pad-accent:#ff6a9b;--pad-accent-ink:#0b0b0b"/);
});

test("real cosmetics: equipped animation, Plus five badges, lapsed perk filtering and plain pad", async () => {
  for(const [kind,id] of Object.entries(F.CASES).filter(([k])=>k!=="season")) {
    const html=await F.render({...seed.helpers,room:{id}}), fx=seed.PC.fx(id), lk=seed.PL.look(id);
    const tmpl=/<template id="rmdId">([\s\S]*?)<\/template>/.exec(html)[1];
    for(const fragment of [fx.cls,fx.layer,fx.glow,fx.badgesMini]) if(fragment)assert.ok(tmpl.includes(fragment),kind+" "+fragment);
    if(kind==="equipped") { assert.match(tmpl,/pfx-f-embers/);assert.match(tmpl,/pfx-g-gold/);assert.match(tmpl,/<picture>/);assert.match(tmpl,/prefers-reduced-motion: reduce/);assert.match(mainTag(html),/--pad-banner-y:20%/); }
    if(kind==="plus") { assert.match(tmpl,/pfx-f-primeplus/);assert.match(tmpl,/pfx-g-primeplus/);assert.equal((tmpl.match(/class="pfx-b mini/g)||[]).length,6);assert.ok(tmpl.indexOf('title="Prime Time Plus"')<tmpl.indexOf('title="Est. 2026"')); }
    if(kind==="lapsed") { assert.doesNotMatch(tmpl,/pfx-f-|pfx-g-|pfx-b-pt|title="On Air"|title="Premiere"/);assert.equal((tmpl.match(/class="pfx-b mini/g)||[]).length,3);assert.equal(seed.PL.cosmeticsOf(id).pad_badge.length,5); }
    if(kind==="plain") { assert.doesNotMatch(mainTag(html),/pad-acc|\bstyle=/);assert.doesNotMatch(tmpl,/pad-av|pfx-f-|pfx-g-|pfx-b /);assert.equal(lk.vars,""); }
  }
});

test("a seasonal cosmetic still draws after its purchase window ends", async () => {
  const real=seed.PC.CAT;
  seed.PC._setCatalog(seed.PC.buildCatalog({items:[...real.items,{id:"fixture_season",kind:"pad_frame",rarity:"rare",price:250000,style:{fx:"snow"},season:{from:"2026-10-01",to:"2026-10-02",label:"Fixture season"}}]},real.rarities));
  try {
    await seed.runQuery("INSERT INTO pad_cosmetic_items(room_id,item_id,kind,state,price,ref,created) VALUES(?, 'fixture_season','pad_frame','owned',0,'fixture-season',?)",[F.CASES.season,Date.UTC(2026,9,1,12)]);
    await seed.PL.setCosmetics(F.CASES.season,{pad_frame:"fixture_season"},"fixture");
    assert.match(await F.render({...seed.helpers,room:{id:F.CASES.season}}),/pfx-f-snow/);
  } finally { seed.PC._setCatalog(real); }
});

test("signed-in empty pads keep their original story entry; signed-out and Dock-off retain prior rules", async () => {
  const on=await F.render({});assert.match(on,/class="card rm-story"/);assert.match(on,/data-story-compose data-pad="Dock\.Equipped"/);
  assert.doesNotMatch(await F.render({padDockOn:false}),/class="card rm-story"/);
  assert.doesNotMatch(await F.render({signedIn:false,linked:false}),/data-story-compose/);
});

test("management and cosmetic entry points survive the Dock",async()=>{
  const f=F.feed(F.CASES.equipped,true);f.mod.admin=true;
  const owner=await F.render({user:"owner-fable",manage:true,feed:f});
  assert.match(owner,/class="ds-btn sm gold po-link/);assert.match(owner,/class="ibtn ps-link/);
  assert.match(owner,/\/premium\?pad=night-orchard/);assert.match(owner,/\/admin\/comps\?pad=night-orchard/);
  const member=await F.render({});assert.match(member,/data-pad-gift="night-orchard"/);assert.match(member,/pad-cosmetics\.js\?v=5/);assert.match(member,/id="gift"/);
  assert.doesNotMatch(owner,/data-pad-gift="night-orchard"/);
});

test("Dock CSS stays scoped, token-based and logical; the pad-accent mapping is one eight-token rule",()=>{
  const css=read("public/css/pad-dock.css").replace(/\/\*[\s\S]*?\*\//g,"");
  const rules=[];function parse(s){let at=0;while(at<s.length){const open=s.indexOf("{",at);if(open<0)break;let d=1,end=open+1;while(end<s.length&&d){if(s[end]==="{")d++;if(s[end]==="}")d--;end++;}const selector=s.slice(at,open).trim(),body=s.slice(open+1,end-1);if(selector.startsWith("@"))parse(body);else if(selector)rules.push({selector,body});at=end;}}parse(css);
  assert.ok(rules.length>10);
  for(const r of rules) {
    for(const sel of r.selector.split(/,\s*(?=main\.|body\.)/))assert.match(sel,/^(main\.rm\.rm-dock|body\.pad-dock-live)/,sel);
    assert.doesNotMatch(r.body,/#[0-9a-f]{3,8}\b|--ds-green|(?:margin|padding)-(?:left|right)\s*:|(?:^|;)\s*(?:left|right)\s*:|text-align:\s*(?:left|right)/i);
    // 1.99?? review: a calc() of --ds-z-* tokens (the banner under the frame layer) is a token value too
    for(const m of r.body.matchAll(/z-index\s*:\s*([^;]+)/g))assert.match(m[1].trim(),/^(?:var\(--ds-z-[\w-]+\)|calc\(\s*(?:-1\s*\*\s*)?var\(--ds-z-[\w-]+\)(?:\s*\+\s*var\(--ds-z-[\w-]+\))?\s*\))$/);
  }
  const tokens=["--ds-ac","--ds-ac-2","--ds-ac-bg","--ds-ac-line","--ds-on-ac","--ds-focus","--ds-focus-ring","--ds-glow"];
  const mapping=rules.filter(r=>r.body.includes("--ds-ac:"));assert.equal(mapping.length,1);
  for(const token of tokens)assert.equal((mapping[0].body.match(new RegExp(token+"\\s*:","g"))||[]).length,1,token);
  assert.doesNotMatch(mapping[0].selector,/#padPanel-(?:feed|about)/);
  assert.match(css,/@media\s*\(max-width:\s*760px\)/);assert.match(css,/@media\s*\(pointer:\s*coarse\)/);assert.match(css,/@media\s*\(hover:\s*none\)/);
  assert.match(css,/forced-colors:\s*active/);assert.doesNotMatch(css,/@import|header[^{}]*height:\s*\d+px/);
  const js=read("public/js/pad-dock.js");assert.doesNotMatch(js,/\bfetch\s*\(|XMLHttpRequest|pfx-f-|pfx-g-|pfx-b|--pad-accent|setProperty|\/cosmetics|\bPALETTE\b|maxBadges|MAX_BADGES|story-compose|story-studio|patvStoryStudio/);
  for(const token of ["--ds-media-bg","--ds-media-chip","--ds-media-panel"])assert.match(read("public/css/ds.css"),new RegExp(token+":"));
});

// 1.99?? dock review: the banner fills the compact header / identity box, so it must paint UNDER padfx's effect layer
// (.pfx-l, z-index 0) - at padfx's own z-index 1 it covered the embers / snow / matrix / pride / pixel and Prime Time rings
// entirely - and the header keeps today's accent tint (.rm.pad-acc .hero) instead of a flat surface (spec D.4).
test("pad frames draw over the banner and the header keeps its accent tint", () => {
  const css=read("public/css/pad-dock.css").replace(/\/\*[\s\S]*?\*\//g,"");
  const rules=[];function parse(s){let at=0;while(at<s.length){const open=s.indexOf("{",at);if(open<0)break;let d=1,end=open+1;while(end<s.length&&d){if(s[end]==="{")d++;if(s[end]==="}")d--;end++;}const selector=s.slice(at,open).trim(),body=s.slice(open+1,end-1);if(!selector.startsWith("@")&&selector)rules.push({selector,body});at=end;}}parse(css);
  const decl=(sel,prop)=>{let v=null;for(const r of rules)if(r.selector.split(/,\s*/).includes(sel)){const m=new RegExp("(?:^|;)\\s*"+prop+"\\s*:\\s*([^;]+)").exec(r.body);if(m)v=m[1].trim();}return v;};
  const negative=v=>/^calc\(\s*-1\s*\*\s*var\(--ds-z-[\w-]+\)\s*\)$/.test(String(v));
  assert.ok(negative(decl("main.rm.rm-dock #rmHero .hero-bn","z-index")),"header banner under the frame layer");
  assert.ok(negative(decl("main.rm.rm-dock .rmd-id > .rmd-id-banner","z-index")),"compact identity banner under the frame layer");
  assert.equal(decl("main.rm.rm-dock .rmd-id","isolation"),"isolate");
  // the banner header is its own stacking context, above the stage overlay and floating chat (--ds-z-sticky), so its ⋯ menu still opens over them
  assert.match(String(decl("main.rm.rm-dock #rmHero.has-bn","z-index")),/^calc\(\s*var\(--ds-z-sticky\)\s*\+\s*var\(--ds-z-raised\)\s*\)$/);
  assert.equal(decl("main.rm.rm-dock #rmHero","background"),null,"no flat background over .rm.pad-acc .hero's tint");
});
