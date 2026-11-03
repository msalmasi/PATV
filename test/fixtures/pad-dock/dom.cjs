"use strict";
// Minimal deterministic DOM for the public Dock controller. No layout emulation:
// geometry, paint, fonts and native-window checks belong to the local browser evidence.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const CL=require('../../../public/js/chatlog-core.js');
class Event {
  constructor(type,o={}){Object.assign(this,{type,bubbles:false,cancelable:true,defaultPrevented:false,button:0},o);}
  preventDefault(){this.defaultPrevented=true;} stopPropagation(){this.stopped=true;} stopImmediatePropagation(){this.immediate=true;this.stopped=true;}
}
class Target {
  constructor(){this.listeners={};}
  addEventListener(t,f,c=false){(this.listeners[t]||=([])).push({f,c:!!c});}
  removeEventListener(t,f,c=false){this.listeners[t]=(this.listeners[t]||[]).filter(x=>x.f!==f||x.c!==!!c);}
  dispatchEvent(e){if(!e.target)e.target=this;const route=[];for(let p=this;p;p=p.parentNode)route.push(p);const fire=(n,c)=>{e.currentTarget=n;for(const x of (n.listeners?.[e.type]||[]).slice()){if(x.c===c)x.f.call(n,e);if(e.immediate)break;}};for(const n of route.slice().reverse()){fire(n,true);if(e.stopped)return !e.defaultPrevented;}fire(this,false);if(e.bubbles&&!e.stopped)for(const n of route.slice(1)){fire(n,false);if(e.stopped)break;}return !e.defaultPrevented;}
}
const escape=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
class Text extends Target{
  constructor(s,doc,comment=false){super();this.nodeType=comment?8:3;this.data=String(s);this.ownerDocument=doc;this.parentNode=null;}
  get textContent(){return this.nodeType===8?'':this.data;} set textContent(v){this.data=String(v);}
  cloneNode(){return new Text(this.data,this.ownerDocument,this.nodeType===8);} remove(){this.parentNode?.removeChild(this);}
  get outerHTML(){return this.nodeType===8?'<!--'+this.data+'-->':escape(this.data);}
}
function simple(n,s){
  if(n.nodeType!==1)return false;
  const attrs=[...s.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)];s=s.replace(/\[[^\]]*\]/g,'');
  for(const a of attrs)if(!n.hasAttribute(a[1])||(a[2]!==undefined&&n.getAttribute(a[1])!==a[2]))return false;
  const tag=/^[\w-]+/.exec(s);if(tag&&n.tagName!==tag[0].toUpperCase())return false;
  const id=/#([\w-]+)/.exec(s);if(id&&n.id!==id[1])return false;
  for(const c of s.matchAll(/\.([\w-]+)/g))if(!n.classList.contains(c[1]))return false;
  return true;
}
function match(n,selector){return selector.split(',').some(s=>{const bits=s.trim().split(/\s*(>)\s*|\s+/).filter(Boolean);function go(node,i){if(!node||!simple(node,bits[i]))return false;if(i===0)return true;if(bits[i-1]==='>')return go(node.parentNode,i-2);for(let p=node.parentNode;p;p=p.parentNode)if(go(p,i-1))return true;return false;}return go(n,bits.length-1);});}
class Element extends Target {
  constructor(tag,doc){super();this.nodeType=tag==='#fragment'?11:1;this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.childNodes=[];this.attrs={};this.parentNode=null;this.style={};this.disabled=false;this.value='';this.scrollTop=0;this.clientHeight=400;this.scrollHeight=1000;this.offsetHeight=300;if(tag==='template')this.content=new Element('#fragment',doc);}
  get className(){return this.attrs.class||'';}set className(v){this.attrs.class=String(v);}
  get id(){return this.attrs.id||'';}set id(v){this.attrs.id=String(v);}
  get hidden(){return this.hasAttribute('hidden');}set hidden(v){v?this.setAttribute('hidden',''):this.removeAttribute('hidden');}
  get classList(){const n=this;return{contains:c=>n.className.split(/\s+/).includes(c),add:(...cs)=>{n.className=[...new Set([...n.className.split(/\s+/).filter(Boolean),...cs])].join(' ');},remove:(...cs)=>{n.className=n.className.split(/\s+/).filter(c=>!cs.includes(c)).join(' ');},toggle(c,w){const yes=w===undefined?!this.contains(c):!!w;yes?this.add(c):this.remove(c);return yes;}};}
  setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return Object.hasOwn(this.attrs,k)?this.attrs[k]:null;}hasAttribute(k){return Object.hasOwn(this.attrs,k);}removeAttribute(k){delete this.attrs[k];}
  get children(){return this.childNodes.filter(n=>n.nodeType===1);}get firstChild(){return this.childNodes[0]||null;}get lastChild(){return this.childNodes.at(-1)||null;}
  get parentElement(){return this.parentNode?.nodeType===1?this.parentNode:null;}get isConnected(){for(let p=this;p;p=p.parentNode)if(p.nodeType===9)return true;return false;}
  get textContent(){return this.childNodes.map(n=>n.textContent).join('');}set textContent(v){for(const n of this.childNodes)n.parentNode=null;this.childNodes=[];if(v!==null&&v!=='')this.appendChild(this.ownerDocument.createTextNode(v));}
  get innerHTML(){return this.childNodes.map(n=>n.outerHTML).join('');}get outerHTML(){if(this.nodeType===11)return this.innerHTML;return '<'+this.tagName.toLowerCase()+Object.entries(this.attrs).map(([k,v])=>' '+k+'="'+escape(v)+'"').join('')+'>'+this.innerHTML+'</'+this.tagName.toLowerCase()+'>';}
  appendChild(n){return this.insertBefore(n,null);}insertBefore(n,ref){if(n.nodeType===11){for(const c of [...n.childNodes])this.insertBefore(c,ref);return n;}if(n.parentNode)n.parentNode.removeChild(n);const i=ref?this.childNodes.indexOf(ref):this.childNodes.length;if(i<0)throw Error('Reference is not a child');this.childNodes.splice(i,0,n);n.parentNode=this;const adopt=x=>{x.ownerDocument=this.ownerDocument;for(const k of x.childNodes||[])adopt(k);};adopt(n);return n;}
  removeChild(n){const i=this.childNodes.indexOf(n);if(i<0)throw Error('Node is not a child');this.childNodes.splice(i,1);n.parentNode=null;return n;}remove(){this.parentNode?.removeChild(this);}replaceWith(n){this.parentNode.insertBefore(n,this);this.remove();}
  insertAdjacentElement(where,n){if(where==='afterend'){const p=this.parentNode;p.insertBefore(n,p.childNodes[p.childNodes.indexOf(this)+1]||null);}else if(where==='beforeend')this.appendChild(n);else throw Error(where);return n;}
  cloneNode(deep=false){const n=new Element(this.tagName.toLowerCase(),this.ownerDocument);n.attrs={...this.attrs};n.value=this.value;Object.assign(n.style,this.style);if(deep)for(const c of this.childNodes)n.appendChild(c.cloneNode(true));if(this.content)n.content=this.content.cloneNode(deep);return n;}
  matches(s){return match(this,s);}closest(s){for(let n=this;n;n=n.parentNode)if(n.nodeType===1&&match(n,s))return n;return null;}
  contains(n){for(let p=n;p;p=p.parentNode)if(p===this)return true;return false;}
  querySelectorAll(s){const out=[];function walk(n){for(const c of n.childNodes||[]){if(match(c,s))out.push(c);walk(c);}}walk(this);return out;}querySelector(s){return this.querySelectorAll(s)[0]||null;}
  getBoundingClientRect(){return{left:50,top:60,width:400,height:300,right:450,bottom:360};}getClientRects(){return this.hidden||this.closest('[hidden],.hide')?[]:[this.getBoundingClientRect()];}
  focus(){this.ownerDocument.activeElement=this;this.dispatchEvent(new Event('focusin',{bubbles:true}));}click(){this.dispatchEvent(new Event('click',{bubbles:true}));}
  requestFullscreen(){const d=this.ownerDocument;d.fullscreenElement=this;d.dispatchEvent(new Event('fullscreenchange'));return Promise.resolve();}
}
class Document extends Element{
  constructor(){super('#document',null);this.ownerDocument=this;this.nodeType=9;this.readyState='complete';this.hidden=false;this.title='Fixture pad';this.documentElement=this.appendChild(new Element('html',this));this.documentElement.dir='ltr';this.documentElement.lang='en';this.head=this.documentElement.appendChild(new Element('head',this));this.body=this.documentElement.appendChild(new Element('body',this));this.activeElement=this.body;}
  createElement(t){return new Element(t,this);}createTextNode(t){return new Text(t,this);}createComment(t){return new Text(t,this,true);}createDocumentFragment(){return new Element('#fragment',this);}getElementById(id){return this.querySelector('#'+id);}
  exitFullscreen(){this.fullscreenElement=null;this.dispatchEvent(new Event('fullscreenchange'));return Promise.resolve();}
}
function harness(extra={}){
  const doc=new Document(),win=new Target();Object.assign(win,{document:doc,navigator:{userAgent:'Fixture browser',platform:'Win32',maxTouchPoints:0},CustomEvent:Event,innerWidth:1440,innerHeight:900,focus(){calls.focus++;}});doc.defaultView=win;
  const calls={focus:0,wake:0,avatar:0,name:0,person:[],topic:0,send:[],insert:[],record:[],adopt:[],tip:[],fit:0,story:0};
  const make=(tag,cls,id,parent,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(id)n.id=id;if(text)n.textContent=text;if(parent)parent.appendChild(n);return n;};
  make('link',null,null,doc.head).setAttribute('rel','stylesheet');make('style',null,null,doc.head,'fixture style');
  const header=make('header',null,null,doc.body,'Standard navbar');const root=make('main','ds-page rm rm-dock chatlog pad-acc',null,doc.body);root.setAttribute('style','--pad-accent:#ff6a9b;--pad-accent-ink:#111111');
  const tmpl=make('template',null,'rmdId',root);const ident=make('div','rmd-id pfx pfx-f-embers',null,tmpl.content);make('span','pfx-l',null,ident);make('span','rmd-id-name',null,ident,'Night Orchard');
  const bar=make('div','rmd-padbar','rmdBar',root),drawer=make('div','rmd-drawer','rmdDrawer',root);make('section',null,'rmHero',drawer);make('nav',null,'padTabs',drawer);
  const panel=make('section',null,'padPanel-live',root);panel.hidden=!!extra.feed;const stage=make('section','card','rmStage',panel);make('div',null,'rmTabs',stage);make('video',null,'rmVideo',stage);make('div',null,'rmCap',stage);
  const strip=make('div','cam-strip','rmStrip',panel),tile=make('div','cs-tile',null,strip);make('video',null,null,tile);
  const body=make('div','rm-live',null,panel),chat=make('section','card','rmChat',body);const scroll=make('div',null,'rmScroll',chat),feed=make('div','feed','rmFeed',scroll);const clip=make('div',null,'rmClip',chat);make('button',null,null,clip,'Clip chat');
  const topic=make('p',null,'rmTopic',chat,'Tonight in the orchard');const audio=make('div',null,'rmAudioBox',chat),audioRow=make('div','rb-audio',null,audio);make('button','rb-play',null,audioRow,'Play');make('button','rb-mute',null,audioRow,'Mute');make('input','rb-vol',null,audioRow);
  const compose=make('div',null,'rmCompose',chat),relay=make('div',null,'rmRelay',compose),form=make('form','rb-say',null,relay),wrap=make('span','rb-say-in',null,form),input=make('input',null,null,wrap);input.maxLength=300;const send=make('button','rb-send',null,form,'Send');const ptt=make('div',null,'rmPtt',compose);make('button','rb-talk',null,ptt,'Hold to talk');const sb=make('div',null,'rmSb',compose),sbToggle=make('button','sbd-toggle',null,sb,'Soundboard');sbToggle.addEventListener('click',()=>sbToggle.setAttribute('aria-expanded','true'));
  const side=make('aside','side',null,body);make('div',null,'rmMicCard',side);make('div',null,'rmPplCard',side);const story=make('section','rm-story',null,root),storyBtn=make('button','ss-add',null,story,'Your story');storyBtn.setAttribute('data-story-compose','');storyBtn.setAttribute('data-pad','fixture-pad');storyBtn.addEventListener('click',()=>calls.story++);
  if(extra.schedule){const go=make('section','golive-card','rmGoLive',panel),slots=make('span','slots',null,go);make('span',null,'rmSlotsTxt',slots,'1/2 slots in use');make('button',null,null,go,'Go live');const schedule=make('div','rs','rmSched',go);make('ul',null,'rsLive',schedule,'On now');make('ul',null,'rsUp',schedule,'Coming up');}
  const F=require('./room.cjs'),h=CL.domH(doc),ctx={offset:0};for(const it of F.initial().feed)feed.appendChild(CL.renderItem(it,ctx,h));
  const person=u=>{calls.avatar++;calls.name++;const n=make('span','rmd-person');n.appendChild(CL.avatarNode(u,ctx,h));n.appendChild(CL.nameNode(u,ctx,h));return n;};
  let duck=false;const opts={root,slug:'night-orchard',signed:true,linked:true,user:'viewer-fable',relay:{getInput:()=>input,sendCmd:t=>calls.send.push(t),insert:(t,o)=>{input.value=t;calls.insert.push({t,o});}},audio:{duck(v){if(v!==undefined)duck=!!v;return duck;},setRecording:v=>calls.record.push(v)},ptt:{adopt:d=>calls.adopt.push(d),onRecording:f=>{calls.recordFn=f;}},person,openPerson:(u,n)=>calls.person.push({u,n}),openTopic:()=>calls.topic++,wake:()=>calls.wake++,stage:{selection:()=>({kind:'mic'}),view:()=>'mic'}};
  Object.assign(opts,extra.opts||{});win.PATVRoom={tipModal:o=>calls.tip.push(o)};win.PATVChipFit={run:()=>calls.fit++};
  let pipDoc,pipWin,resolvePip;if(extra.pip){win.documentPictureInPicture={requestWindow:()=>{pipDoc=new Document();pipWin=new Target();Object.assign(pipWin,{document:pipDoc,closed:false,close(){if(this.closed)return;this.closed=true;this.dispatchEvent(new Event('pagehide'));}});pipDoc.defaultView=pipWin;return extra.deferPiP?new Promise(resolve=>{resolvePip=()=>resolve(pipWin);}):Promise.resolve(pipWin);}};}
  const timers=new Map();let seq=0;const sandbox={window:win,document:doc,setTimeout:f=>{timers.set(++seq,f);return seq;},clearTimeout:i=>timers.delete(i),Promise,JSON};vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../../public/js/pad-dock.js'),'utf8'),sandbox);
  const controller=win.PATVPadDock.init(opts);controller.update(F.initial());controller.mic(F.initial().mic);
  return{doc,win,root,header,bar,drawer,panel,stage,strip,tile,chat,feed,compose,input,send,ptt,sb,side,story,controller,calls,make,timers,Event,resolvePip(){resolvePip();},get pipDoc(){return pipDoc;},get pipWin(){return pipWin;},button(label,within=doc){const b=within.querySelectorAll('button').find(n=>n.getAttribute('aria-label')===label||n.textContent===label);if(!b)throw Error('No button '+label);return b;},tick(){for(const [i,f]of [...timers]){timers.delete(i);f();}}};
}
module.exports={harness,Event,Document,Element};
