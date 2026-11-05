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
  // 1.99ajf dockclean (owner points 1, 33): no phone pad bar / drawer and no crumb; the Live panel keeps an sr-only h1 with the pad's name;
  // the story strip opens the Feed tab, the launchpad card ends About, the Latest posts card is not on Live
  assert.doesNotMatch(html,/id="rmd(?:Drawer|Bar)"/);assert.doesNotMatch(html,/class="crumb"/);
  assert.match(section(html,"padPanel-live"),/<h1 class="ds-sr-only">Night Orchard<\/h1>/);
  const feedAt=html.indexOf('id="padPanel-feed"'),aboutAt=html.indexOf('id="padPanel-about"');
  assert.ok(html.indexOf('class="card rm-story"')>feedAt&&html.indexOf('class="card rm-story"')<aboutAt,"the story strip is the Feed tab's first card");
  assert.ok(html.indexOf('id="padLaunch"')>aboutAt,"the launchpad card is in About");
  assert.match(await F.render({padDockOn:false}),/class="crumb"/,"the legacy page keeps its crumb");
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
    // (1.99ajh dockpop: + the chat window's body, and the person menu's Dock look while the chat floats off Live or is in its own window)
    // (1.99ajh dockpop review: + body.rmd-afloat - a Dock notice moves to the top while the chat floats)
    for(const sel of r.selector.split(/,\s*(?=main\.|body[.:])/))assert.match(sel,/^(main\.rm\.rm-dock|body\.pad-dock-live|body\.rmd-pop|body\.rmd-afloat|body\.rmd-dock-pad|body:is\(\.pad-dock-live, \.rmd-afloat, \.rmd-pop\))/,sel);   // (1.99ajq dockpol: + body.rmd-dock-pad - the pad page's Feed / About in the Dock: no footer)
    assert.doesNotMatch(r.body,/#[0-9a-f]{3,8}\b|--ds-green|(?:margin|padding)-(?:left|right)\s*:|(?:^|;)\s*(?:left|right)\s*:|text-align:\s*(?:left|right)/i);
    // 1.99aiw review: a calc() of --ds-z-* tokens (the banner under the frame layer) is a token value too
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

// 1.99aiw dock review: the banner fills the compact header / identity box, so it must paint UNDER padfx's effect layer
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

// 1.99aiw dock review: body.pad-dock-live has a floor (min-block-size 520px, 440px on phones) like /messages' body.dm-page, but it
// also had overflow: hidden, which the body hands to the viewport: in a window shorter than the floor (a phone held sideways,
// 812x375) the page could not be scrolled and the composer (input, Hold to talk, Send) sat below the fold, out of reach
test("a window shorter than the Live frame's floor can still scroll to the composer", () => {
  const css=read("public/css/pad-dock.css").replace(/\/\*[\s\S]*?\*\//g,"");
  const re=/([^{}]+)\{([^{}]*)\}/g;let m,floor=false;
  while((m=re.exec(css))){
    if(!m[1].split(",").map(s=>s.trim()).includes("body.pad-dock-live"))continue;
    if(/min-block-size\s*:/.test(m[2]))floor=true;
    assert.doesNotMatch(m[2],/(?:^|;)\s*overflow(?:-y|-block)?\s*:\s*(?:hidden|clip)\b/,"the viewport must stay scrollable");
  }
  assert.ok(floor,"the frame keeps its floor");
});

// ── 1.99ajc dockfu: the lead's design calls (hand-off 18 follow-ups, D1) ──
const dockRules=()=>{const css=read("public/css/pad-dock.css").replace(/\/\*[\s\S]*?\*\//g,"");const rules=[];
  (function parse(s,at){let i=0;while(i<s.length){const open=s.indexOf("{",i);if(open<0)break;let d=1,end=open+1;while(end<s.length&&d){if(s[end]==="{")d++;if(s[end]==="}")d--;end++;}
    const selector=s.slice(i,open).trim(),body=s.slice(open+1,end-1);if(selector.startsWith("@"))parse(body,(at?at+" ":"")+selector);else if(selector)rules.push({selector,body,at:at||""});i=end;}})(css,"");
  return rules;};
const declOf=(rules,sel,prop,at="")=>{let v=null;for(const r of rules)if(r.at===at&&r.selector.split(/,\s*/).includes(sel)){const m=new RegExp("(?:^|;)\\s*"+prop+"\\s*:\\s*([^;]+)").exec(r.body);if(m)v=m[1].trim();}return v;};

// (a) the Live frame keeps the page's own max width (.rm / .ds-page) and centres in it - not edge to edge on a wide screen
test("dockfu: the Live frame follows the page width; only the Picture-in-Picture window runs full width", () => {
  const rules=dockRules();
  // (the frame = a rule on main.rm.rm-dock itself; a player inside it may of course fill its own box)
  for(const r of rules)for(const sel of r.selector.split(/,\s*/))if(/main\.rm\.rm-dock(?:\[[^\]]+\])?$/.test(sel)&&/max-inline-size\s*:\s*none|max-width\s*:\s*none/.test(r.body))
    assert.match(sel,/\[data-rmd-pip\]$/,sel+" may not lift the page width");
  assert.equal(declOf(rules,"main.rm.rm-dock","inline-size"),"100%","fills up to the page's max width");
  assert.match(read("public/css/ds.css"),/\.ds-page \{[^}]*max-width: var\(--ds-w\);[^}]*margin-inline: auto;/);
  assert.match(read("views/room.ejs"),/<main class="ds-page rm chatlog/);
});

// (b) the banner shows through the Dock header: a 50-60% scrim (was .88), and every piece of header text without an opaque pill of its
// own sits on a --ds-media-panel plate. The sums: over the worst banner (pure white) the plate's backdrop is at least as dark as the
// page's #0d0d0d - the floor padlook's 4.5:1 accent guard is measured on - so every accent a pad can have (each preset, a custom one the
// guard lifted to its 4.5:1 minimum) and the default green keep 4.5:1, as do the text greys. Both accent cases: a pad with a look (its
// accent) and one without (the design system's green).
test("dockfu: the banner shows through a lighter scrim and the header text keeps 4.5:1 in both accent cases", () => {
  const rules=dockRules(),PL=seed.PL,ds=read("public/css/ds.css");
  const scrim=declOf(rules,"main.rm.rm-dock #rmHero .hero-bn::after","background");
  assert.equal(declOf(rules,"main.rm.rm-dock .rmd-id-banner::after","background"),scrim,"the compact identity uses the same scrim");
  const m=/^color-mix\(in srgb, var\(--ds-media-bg\) (\d+)%, transparent\)$/.exec(String(scrim));assert.ok(m,String(scrim));
  const a=Number(m[1])/100;assert.ok(a>=0.5&&a<=0.6,"scrim "+a+" (the lead's call: about .5-.6)");
  assert.equal(/--ds-media-bg:\s*(#[0-9a-f]{3,6})/i.exec(ds)[1],"#000");
  const plateA=Number(/--ds-media-panel:\s*rgba\(0,\s*0,\s*0,\s*([.\d]+)\)/.exec(ds)[1]);
  const plates=["main.rm.rm-dock #rmHero.has-bn .hd-nm","main.rm.rm-dock #rmHero.has-bn a.hd-about","main.rm.rm-dock #rmHero.has-bn .hd-fc","main.rm.rm-dock #rmHero.has-bn .hd-fcs","main.rm.rm-dock #rmHero.has-bn .fw-btn.on","main.rm.rm-dock .rmd-id:has(> .rmd-id-banner) .rmd-id-name"];
  const plateRule=rules.find(r=>/background-color\s*:\s*var\(--ds-media-panel\)/.test(r.body)&&r.selector.includes("#rmHero.has-bn :is("));
  assert.ok(plateRule,"the header's text plates");
  for(const p of ["hd-nm","a.hd-about","hd-fc","hd-fcs","fw-btn.on"])assert.ok(plateRule.selector.includes(p),p);
  assert.ok(plateRule.selector.includes(".rmd-id:has(> .rmd-id-banner) .rmd-id-name"));assert.ok(plates.length);
  // the name's plate margin is a spread shadow, never padding (pad-chipfit.js fits the badges into the box's clientWidth)
  assert.match(String(declOf(rules,"main.rm.rm-dock #rmHero.has-bn .hd-nm","box-shadow")),/^0 0 0 var\(--ds-sp-1\) var\(--ds-media-panel\)$/);
  assert.equal(declOf(rules,"main.rm.rm-dock #rmHero.has-bn .hd-nm","padding"),null);
  // worst case: a pure white banner -> under the scrim, then under the plate (sRGB compositing, as browsers do)
  const hex=v=>"#"+[v,v,v].map(x=>Math.round(x).toString(16).padStart(2,"0")).join("");
  const under=255*(1-a),plate=hex(under*(1-plateA)),bare=hex(under);
  assert.ok(PL.luminance(plate)<=PL.luminance(PL.BG)+1e-9,"the plate's worst backdrop "+plate+" is no lighter than "+PL.BG);
  const tok=n=>PL.normHex(new RegExp(n+":\\s*(#[0-9a-f]{3,6})\\b","i").exec(ds)[1]);
  const texts={"--ds-text-strong":tok("--ds-text-strong"),"--ds-text":tok("--ds-text"),"--ds-text-muted":tok("--ds-text-muted"),"--ds-green-2 (no look)":tok("--ds-green-2")};
  for(const p of PL.PALETTE)texts["preset "+p.id]=p.hex;
  for(const dark of ["#101030","#3a0000","#002a10","#202020"]){const g=PL.guardAccent(dark);assert.ok(g.ratio>=4.5);texts["guarded "+dark+" -> "+g.hex]=g.hex;}
  for(const [name,c] of Object.entries(texts))assert.ok(PL.contrast(c,plate)>=4.5,name+" on "+plate+": "+PL.contrast(c,plate).toFixed(2));
  // without a plate only the strong white would pass over a white banner - which is why every text piece has one
  assert.ok(PL.contrast(texts["--ds-text-strong"],bare)>=4.5);assert.ok(PL.contrast(texts["--ds-text-muted"],bare)<4.5);
});
// 1.99ajc dockfu: review - the plates leave the header's layout as it was. Padding on About and the follower count widened the
// header's right side by 24px, and pad-chipfit.js lets the badges use everything but the name's 8ch floor - so at 800x900 the pad's
// name went into its ellipsis ("Night Orc…", full before) and a Prime Time Plus pad's to 84 of 115px at 1280-1440. Their plate
// margin is a spread shadow, as the name's is (browser check: the names are full again where they were).
test("dockfu: review - the header's text plates add no width (their margin is a spread shadow, never padding)", () => {
  const rules=dockRules(),pieces=["hd-nm","a.hd-about","hd-fc","hd-fcs","fw-btn.on"];
  for(const r of rules)if(!r.at&&r.selector.includes("#rmHero.has-bn")&&pieces.some(p=>r.selector.includes(p)))
    assert.doesNotMatch(r.body,/(?:^|;)\s*(?:padding|padding-inline|padding-left|padding-right|margin|margin-inline|margin-left|margin-right)\s*:/,r.selector+" adds width");
  for(const sel of ["main.rm.rm-dock #rmHero.has-bn a.hd-about","main.rm.rm-dock #rmHero.has-bn .hd-fc"])
    assert.match(String(declOf(rules,sel,"box-shadow")),/^0 0 0 var\(--ds-sp-1\) var\(--ds-media-panel\)$/,sel);
});

// (c) a readable chat on a short window, after the clean-up: the stage card shrinks first (flex 0 1 auto, its own floor) and the log keeps
// a floor that reaches the Live panel's flex column (the chat card's and the body's content-based minimum; the people column is
// size-contained). The pinned cams are inside the stage card, so there is no separate strip to fold.
test("dockfu: the chat keeps a readable floor on short windows - the stage gives way first", () => {
  const rules=dockRules(),P="body.pad-dock-live main.rm.rm-dock #padPanel-live";
  assert.equal(declOf(rules,"body.pad-dock-live main.rm.rm-dock","--rmd-log-min"),"120px");
  assert.equal(declOf(rules,"body.pad-dock-live main.rm.rm-dock","--rmd-log-min","@media (max-width: 760px)"),"112px");
  assert.equal(declOf(rules,P+" .rmd-log","min-block-size"),"var(--rmd-log-min)");
  assert.equal(declOf(rules,P+" #rmChat","min-block-size"),"auto");
  assert.equal(declOf(rules,P+" .rmd-body","min-block-size"),"auto");
  assert.equal(declOf(rules,P+" .rmd-body > .side","contain"),"size","the people column's list never counts toward the floor");
  assert.equal(declOf(rules,P,"container"),"rmd-live / size");
  assert.equal(declOf(rules,"main.rm.rm-dock #rmStage","flex"),"0 1 auto");
  // (1.99ajq dockpol (owner item 16): + the pinned cams' row under the video at every width - --rmd-pin-row, 0 without pins)
  assert.equal(declOf(rules,"main.rm.rm-dock #rmStage","block-size"),"calc(clamp(140px, 36cqb, 560px) + var(--rmd-pin-row))");
  assert.equal(declOf(rules,"main.rm.rm-dock #rmStage","min-block-size"),"calc(96px + var(--rmd-pin-row))");
  assert.match(String(declOf(rules,"main.rm.rm-dock #rmStage","block-size","@media (max-width: 760px)")),/min\(56\.25cqi, 36cqb\)/,"phones: 16:9 of the width or 36% of the panel");
  for(const r of rules)if(/--rmd-log-min\)/.test(r.body))assert.ok(r.selector.startsWith(P),r.selector);
});

// 1.99ajf dockclean (owner points 9, 19, 24): the bottom bar is a 3-column grid - [▶ / ❚❚] [the now zone: eq + holders, or the state]
// [🔊 · volume · 🎚️] - and holds nothing else: the ⚡ live / standard pill, Jump to live, duck and A/V sync are Audio settings. The state
// text is hidden in normal playback (the eq is the live signal) and while holders show.
test("dockclean: the bottom bar is play · now · a fixed right cluster; mode, jump, duck and A/V sync live in Audio settings", () => {
  const rules=dockRules(),S="main.rm.rm-dock #rmAudioBox";
  const raw=(sel,prop)=>{const r=rules.find(x=>!x.at&&x.selector===sel);const m=r&&new RegExp("(?:^|;)\\s*"+prop+"\\s*:\\s*([^;]+)").exec(r.body);return m?m[1].trim():null;};
  assert.equal(declOf(rules,S+" .rb-audio.rmd-bar","display"),"grid");
  assert.equal(declOf(rules,S+" .rb-audio.rmd-bar","grid-template-columns"),"36px minmax(0, 1fr) auto");
  assert.equal(raw(S+" .rmd-bar > :not(.rb-play, .rmd-now, .rmd-right)","display"),"none");
  assert.equal(raw("main.rm.rm-dock .rmd-now :is(.rb-state.live, .rb-state:empty)","display"),"none");
  assert.equal(declOf(rules,"main.rm.rm-dock .rmd-now.rmd-has-holders .rb-state","display"),"none");
  assert.equal(declOf(rules,"main.rm.rm-dock .rmd-right","flex"),"none","the right cluster never moves");
  assert.equal(declOf(rules,"main.rm.rm-dock .rmd-now","min-inline-size"),"0");
});

// (f) the pad-accent focus ring stays (owner-approved exception): the mapping still points --ds-focus at the pad's accent
test("dockfu: the pad-accent focus ring stays", () => {
  const rules=dockRules(),mapping=rules.filter(r=>r.body.includes("--ds-ac:"));
  assert.equal(mapping.length,1);assert.match(mapping[0].body,/--ds-focus:\s*var\(--pad-accent\)/);
  assert.match(mapping[0].body,/--ds-focus-ring:\s*0 0 0 2px var\(--ds-bg\), 0 0 0 4px var\(--ds-focus\)/);
  assert.match(read("docs/design-system.md"),/owner approved/i);
});
