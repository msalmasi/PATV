"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const {Document, Event} = require("./fixtures/pad-dock/dom.cjs");
const source = fs.readFileSync(path.join(__dirname, "../public/js/pad-picker.js"), "utf8");
const flush = async () => { for(let i=0;i<8;i++) await Promise.resolve(); };
function setup(flags = {}, fetcher, tab) {
  const doc = new Document(), root = doc.createElement("main"); root.className="rm rm-dock";doc.body.appendChild(root);
  const input = doc.createElement("input");input.value="My draft";root.appendChild(input);
  const calls={requests:[],send:[],insert:[],closed:0}, win={URL,fetch(url,opts){calls.requests.push({url,opts});return fetcher ? fetcher(url,opts) : Promise.resolve({ok:true,json:()=>Promise.resolve([])});}};
  vm.runInNewContext(source,{window:win});
  let sheet, accepted=true;
  const opts={root,signed:true,slug:"night-orchard",data:{room:{relay:true,...flags}},relay:{getInput:()=>input,_send(token){calls.send.push(token);return accepted;},insert(emoji){calls.insert.push(emoji);return emoji;}},
    sheet(){sheet=doc.createElement("section");sheet.className="ds-modal";root.appendChild(sheet);return sheet;},
    closeLayer(){calls.closed++;if(sheet)sheet.remove();},tab};
  const picker=win.PATVPadPicker.open(opts);
  return {doc,root,input,win,calls,opts,picker,get sheet(){return sheet;},tab(id){return picker.tabs.find(x=>x.id===id).button;},rejectSend(){accepted=false;}};
}
const response = rows => Promise.resolve({ok:true,json:()=>Promise.resolve(rows)});

test("picker requires signed-in text relay; unavailable provider tabs make no request",()=>{
  const h=setup();assert.equal(h.picker.current(),"emoji");assert.deepEqual([...h.picker.tabs.map(x=>x.id)],["patv","emoji"]);assert.equal(h.calls.requests.length,0);
  assert.equal(h.win.PATVPadPicker.available(h.opts.data,{signed:false,relay:{}}),false);
  assert.equal(h.win.PATVPadPicker.available({room:{relay:false}},{signed:true,relay:{}}),false);
  assert.equal(h.win.PATVPadPicker.open({...h.opts,signed:false}),null);
  const emoji=h.sheet.querySelectorAll(".rmp-grid button");assert.ok(emoji.length>30 && emoji.length<=150);
  // 1.99ajf dockclean (owner point 20): an emoji goes in at the caret and the sheet stays open for more
  emoji[0].click();emoji[1].click();assert.deepEqual([...h.calls.insert],["😀","😃"]);assert.equal(h.calls.closed,0);assert.equal(h.sheet.isConnected,true);assert.equal(h.calls.send.length,0);
});

test("stickers use the existing outbox once and preserve the typed draft",async()=>{
  const h=setup({cfstickerPicker:true},()=>response([
    {id:42,set:1642,desc:"Friendly frog",src:"/media/cfsticker/42.webp"},
    {id:43,set:1642,desc:"bad source",src:"https://elsewhere.invalid/p.png"},
    {id:"42] extra",set:1642,desc:"bad token",src:"/media/cfsticker/42] extra.webp"}
  ]));await flush();
  assert.equal(h.calls.requests[0].url,"/api/rooms/night-orchard/cfstickers");assert.equal(h.calls.requests[0].opts.headers["X-Requested-With"],"fetch");
  const buttons=h.sheet.querySelectorAll(".rmp-grid button");assert.equal(buttons.length,1);assert.equal(buttons[0].getAttribute("aria-label"),"Send sticker: Friendly frog");
  buttons[0].click();buttons[0].click();assert.deepEqual(h.calls.send,["[cfsticker:1642/42]"]);assert.equal(h.input.value,"My draft");assert.equal(h.calls.insert.length,0);
});

test("a full outbox keeps the picker and selected item available for retry",async()=>{
  const h=setup({cfstickerPicker:true},()=>response([{id:42,set:1642,desc:"Frog",src:"/media/cfsticker/42.webp"}]));h.rejectSend();await flush();
  h.sheet.querySelector(".rmp-grid button").click();assert.equal(h.calls.closed,0);assert.equal(h.sheet.isConnected,true);assert.match(h.sheet.textContent,/still on their way/);
});

test("GIF searches are explicit, capped, branded and use only validated thumbnails",async()=>{
  const h=setup({gifPicker:true},()=>response([
    {id:"gif_safe",title:"<img onerror=alert(1)>",preview:{src:"https://static.klipy.com/safe.gif"}},
    {id:"gif_bad",title:"Bad host",preview:{src:"https://static.klipy.com.evil.invalid/bad.gif"}},
    {id:"gif_credentials",title:"Credentials",preview:{src:"https://u:p@static.klipy.com/bad.gif"}}
  ]));await flush();assert.equal(h.calls.requests.length,1);
  // 1.99aiw dock: review - privacy: a POST {q, pad}, never the words in the URL (nginx / Cloudflare request logs)
  assert.equal(h.calls.requests[0].url,"/api/gifs/search");assert.equal(h.calls.requests[0].opts.method,"POST");
  assert.equal(h.calls.requests[0].opts.headers["X-Requested-With"],"fetch");assert.equal(h.calls.requests[0].opts.headers["Content-Type"],"application/json");
  assert.deepEqual(JSON.parse(h.calls.requests[0].opts.body),{q:"",pad:"night-orchard"});
  const input=h.sheet.querySelector("input");assert.equal(input.placeholder,"Search KLIPY");assert.equal(input.maxLength,50);
  input.value="a".repeat(60);input.dispatchEvent(new Event("input"));assert.equal(h.calls.requests.length,1,"typing does not issue repeated searches");
  h.sheet.querySelector("form").dispatchEvent(new Event("submit"));await flush();
  assert.equal(h.calls.requests[1].url,"/api/gifs/search");assert.equal(JSON.parse(h.calls.requests[1].opts.body).q.length,50);
  const rows=h.sheet.querySelectorAll(".rmp-grid button");assert.equal(rows.length,1);assert.equal(rows[0].querySelectorAll("img").length,1);assert.match(h.sheet.outerHTML,/&lt;img onerror/);assert.match(h.sheet.textContent,/via KLIPY/);
  rows[0].click();assert.deepEqual(h.calls.send,["[gif:gif_safe]"]);assert.equal(h.calls.closed,1);
});

test("late provider results cannot populate a different tab or a closed sheet",async()=>{
  const pending=[];const h=setup({cfstickerPicker:true,gifPicker:true},()=>new Promise(resolve=>pending.push(resolve)));
  h.tab("gifs").click();h.tab("emoji").click();pending[0]({ok:true,json:()=>Promise.resolve([{id:42,set:1642,desc:"Late sticker",src:"/media/cfsticker/42.webp"}])});pending[1]({ok:true,json:()=>Promise.resolve([{id:"late",title:"Late GIF",preview:{src:"https://static.klipy.com/late.gif"}}])});await flush();
  assert.equal(h.picker.current(),"emoji");assert.equal(h.sheet.querySelectorAll("img").length,0);assert.doesNotMatch(h.sheet.textContent,/Late/);
  h.tab("gifs").click();h.opts.closeLayer(false);pending[2]({ok:true,json:()=>Promise.resolve([{id:"late",title:"Closed GIF",preview:{src:"https://static.klipy.com/late.gif"}}])});await flush();assert.equal(h.sheet.querySelectorAll("img").length,0);
});

test("tab keyboard navigation respects RTL and keeps selected state in sync",()=>{
  for(const rtl of [false,true]){
    const h=setup({cfstickerPicker:true,gifPicker:true});h.doc.documentElement.dir=rtl?"rtl":"ltr";
    h.tab("stickers").dispatchEvent(new Event("keydown",{key:"ArrowRight"}));assert.equal(h.picker.current(),rtl?"patv":"gifs");
    h.tab(h.picker.current()).dispatchEvent(new Event("keydown",{key:"End"}));assert.equal(h.picker.current(),"emoji");assert.equal(h.tab("emoji").getAttribute("aria-selected"),"true");
    h.tab("emoji").dispatchEvent(new Event("keydown",{key:"Home"}));assert.equal(h.picker.current(),"patv");assert.equal(h.doc.activeElement===h.tab("patv"),true);
  }
});

test("provider errors stay generic and image failure leaves its text label",async()=>{
  const h=setup({gifPicker:true},()=>Promise.reject(new Error("PRIVATE_API_KEY_FAILURE")));await flush();
  assert.match(h.sheet.textContent,/Could not load/);assert.doesNotMatch(h.sheet.textContent,/PRIVATE_API_KEY/);
  const s=setup({cfstickerPicker:true},()=>response([{id:42,set:1642,desc:"Frog caption",src:"/media/cfsticker/42.webp"}]));await flush();
  const image=s.sheet.querySelector("img");image.dispatchEvent(new Event("error"));assert.equal(image.hidden,true);assert.match(s.sheet.textContent,/Frog caption/);
});

test("a full input does not send or close and all picker keys exist in English",()=>{
  const h=setup();h.opts.relay.insert=()=>"";h.sheet.querySelector(".rmp-grid button").click();assert.equal(h.calls.closed,0);assert.equal(h.calls.send.length,0);assert.match(h.sheet.textContent,/message is full/);
  const en=JSON.parse(fs.readFileSync(path.join(__dirname,"../locales/en.json"),"utf8"));
  for(const match of source.matchAll(/\bt\('([a-z_]+)',/g))assert.equal(typeof en["js.pad.picker."+match[1]],"string",match[1]);
  assert.doesNotMatch(source,/innerHTML|localStorage|sessionStorage|KLIPY_API_KEY|:shortcode:/);
});

// 1.99ajf dockclean (owner point 21): 🧸 PATV - the site's own packs the viewer owns or has as a perk (GET /api/stickers); a pick sends
// exactly the [sticker:<pack>/<id>] token through the outbox; no packs yet -> the store link; voices() is the catalogue for Say it
test("the PATV tab lists only owned packs with the site's own art and sends exactly one sticker token",async()=>{
  const h=setup({},url=>url==="/api/stickers"?Promise.resolve({ok:true,json:()=>Promise.resolve({ok:true,packs:[
    {id:"miclife",name:"Mic life",emoji:"🎙️",owned:true,stickers:[{id:"who",name:"Who's talking?",url:"/public/stickers/miclife/who.svg"},{id:"evil",name:"Elsewhere",url:"https://elsewhere.invalid/x.svg"}]},
    {id:"notmine",name:"Not mine",owned:false,stickers:[{id:"a",name:"A",url:"/public/stickers/notmine/a.svg"}]}]})}):response([]),"patv");await flush();
  assert.equal(h.picker.current(),"patv");assert.equal(h.calls.requests[0].url,"/api/stickers");
  const b=h.sheet.querySelectorAll(".rmp-grid button");assert.equal(b.length,1);assert.equal(b[0].getAttribute("aria-label"),"Send sticker: Who's talking?");assert.doesNotMatch(h.sheet.textContent,/Not mine/);
  b[0].click();assert.deepEqual(h.calls.send,["[sticker:miclife/who]"]);assert.equal(h.calls.closed,1);
  const e=setup({},()=>Promise.resolve({ok:true,json:()=>Promise.resolve({ok:true,packs:[]})}),"patv");await flush();
  assert.match(e.sheet.textContent,/No sticker packs yet/);assert.equal(e.sheet.querySelector("a").href,"/cosmetics?tab=stickers");
});
test("voices() asks the site's catalogue once and hands back its list",async()=>{
  const h=setup({},url=>url==="/api/voices"?Promise.resolve({ok:true,json:()=>Promise.resolve({ok:true,voices:[{id:"v1"}]})}):response([]));
  const a=await h.win.PATVPadPicker.voices(),b=await h.win.PATVPadPicker.voices();assert.equal(a[0].id,"v1");assert.equal(a,b);
  assert.equal(h.calls.requests.filter(r=>r.url==="/api/voices").length,1);
});
