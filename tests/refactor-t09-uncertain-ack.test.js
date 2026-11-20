'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {ReminderService,RETRY_DELAY_MS}=require('../src/modules/reminders');
const {Router}=require('../src/http/router');
const {Gateway}=require('../src/adapters/gateway');
const register=require('../src/modules/reminders/routes');
const NOW=Date.UTC(2026,10,16,12),TOKEN='synthetic-round2-token';
function fixture(t,kind='ordinary'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-t09-uncertain-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const clock={now:NOW},config={paths:{dataDir:root},env:{timezone:'UTC'},reminder:{enabled:true,maxPerDay:1},server:{allowRemote:false},gateway:{wechat:{inboundToken:TOKEN}}};
 const logs=[],logger={info:v=>logs.push(v),warn:v=>logs.push(v),error:v=>logs.push(v),debug(){}};
 const make=()=>new ReminderService(config,{now:()=>clock.now,logger}),svc=make();svc.pluginAllowed=()=>true;
 const item=kind==='ordinary'?svc.add({wxid:'fixture-round2',text:'Synthetic reminder body',at:NOW+1000}):svc.enqueueNow({wxid:'fixture-round2',text:'Synthetic private body',kind,pluginId:'synthetic-plugin',pluginHash:'synthetic-hash'});
 clock.now+=1000;assert.equal(svc.due()[0].id,item.id);
 return {root,clock,config,logs,logger,make,svc,item};
}
const disk=f=>({main:fs.readFileSync(f.svc.file,'utf8'),mirror:fs.readFileSync(f.svc.file+'.bak','utf8')});
function router(f){const gateway=new Gateway({platform:'wechat',options:{inboundToken:TOKEN},logger:f.logger});const runtime={config:f.config,reminders:f.svc,gateways:new Map([['wechat',gateway]]),logger:f.logger};const r=new Router(runtime);register(r);return r;}
async function request(f,body,{token=TOKEN,ip='127.0.0.1',origin,raw}={}){
 const req=new EventEmitter();Object.assign(req,{method:'POST',url:'/api/reminders/ack',headers:{host:'127.0.0.1','content-type':'application/json',...(token===null?{}:{'x-bot-token':token}),...(origin?{origin}:{})},socket:{remoteAddress:ip}});
 const res={headers:{},statusCode:0,body:'',setHeader(k,v){this.headers[k]=v;},writeHead(status,headers){this.statusCode=status;Object.assign(this.headers,headers);},end(value){this.body=value;this.writableEnded=true;}};
 const pending=router(f).handle(req,res);req.emit('data',Buffer.from(raw??JSON.stringify(body)));req.emit('end');await pending;
 return {status:res.statusCode,body:JSON.parse(res.body),headers:res.headers};
}
for(const ok of [false,true])test(`T09 round2: uncertain overrides ok=${ok} for a sending reminder`,t=>{
 const f=fixture(t),out=f.svc.ack(f.item.id,{ok,uncertain:true,error:'synthetic opaque transport outcome'});
 assert.equal(out.ok,true);assert.equal(out.item.status,'unconfirmed');assert.equal(out.item.attempts,1);assert.equal(out.item.retryAt,0);assert.equal(out.item.claimedAt,NOW+1000);
 assert.equal(JSON.parse(disk(f).main).items[0].status,'unconfirmed');assert.deepEqual(disk(f).main,disk(f).mirror);
 f.clock.now+=RETRY_DELAY_MS*2;assert.deepEqual(f.svc.due(),[]);assert.equal(f.svc.nextDueAt(),0);
});
test('T09 round2: duplicate uncertain ACK preserves terminal bytes attempts timestamps and quota',t=>{
 const f=fixture(t);f.svc.ack(f.item.id,{uncertain:true,error:'first evidence'});const saved=disk(f),item={...f.svc.items[0]},quota=f.svc.rules().sentToday;
 f.clock.now+=2000;const out=f.svc.ack(f.item.id,{ok:true,uncertain:true,error:'contradictory second evidence'});
 assert.equal(out.ok,true);assert.deepEqual(out.item,item);assert.deepEqual(disk(f),saved);assert.equal(f.svc.rules().sentToday,quota);
 const reloaded=f.make();assert.deepEqual(reloaded.ack(f.item.id,{uncertain:true}).item,item);assert.deepEqual(disk(f),saved);
});
test('T09 round2: confirmed ACK cannot promote unconfirmed terminal evidence',t=>{
 const f=fixture(t);f.svc.ack(f.item.id,{uncertain:true});const saved=disk(f),item={...f.svc.items[0]};
 for(const body of [{ok:true},{ok:false},{ok:true,uncertain:false}]){const out=f.svc.ack(f.item.id,body);assert.equal(out.statusCode,409);assert.deepEqual(f.svc.items[0],item);assert.deepEqual(disk(f),saved);}
});
test('T09 round2: uncertainty never downgrades an already confirmed done item',t=>{
 const f=fixture(t);f.svc.ack(f.item.id,{ok:true});const saved=disk(f),item={...f.svc.items[0]};f.clock.now+=2000;
 for(const body of [{ok:true,uncertain:true},{ok:false,uncertain:true}]){f.svc.ack(f.item.id,body);assert.deepEqual(f.svc.items[0],item);assert.deepEqual(disk(f),saved);}
 assert.equal(f.svc.ack(f.item.id,{ok:true}).ok,true);
});
for(const status of ['pending','retrying','failed','expired','cancelled'])test(`T09 round2: uncertain ACK rejects ${status} without rewriting state`,t=>{
 const f=fixture(t);f.svc.items[0].status=status;f.svc.save();const saved=disk(f),before=JSON.stringify(f.svc.items);
 const out=f.svc.ack(f.item.id,{ok:true,uncertain:true});assert.equal(out.statusCode,409);assert.equal(JSON.stringify(f.svc.items),before);assert.deepEqual(disk(f),saved);
});
test('T09 round2: unknown reminder ID retains404 contract',t=>{const f=fixture(t);assert.equal(f.svc.ack('missing',{uncertain:true}).statusCode,404);});
test('T09 round2: uncertain diary removes body and remains uncertain after expiry and reload',t=>{
 const f=fixture(t,'diary');const out=f.svc.ack(f.item.id,{ok:true,uncertain:true});assert.equal(out.item.status,'unconfirmed');assert.equal(out.item.text,'（日记发送结果不确定）');
 f.clock.now+=RETRY_DELAY_MS*2;f.svc.expire();const loaded=f.make();loaded.sweepStale();assert.deepEqual(loaded.due(),[]);assert.equal(loaded.items[0].text,'（日记发送结果不确定）');assert.ok(!disk(f).main.includes('Synthetic private body'));
});
test('T09 round2: actual Router route body reader and Gateway auth pass uncertain to durable service',async t=>{
 const f=fixture(t),out=await request(f,{id:f.item.id,ok:true,uncertain:true,error:'synthetic unknown'});assert.equal(out.status,200);assert.equal(out.body.item.status,'unconfirmed');assert.equal(JSON.parse(disk(f).main).items[0].status,'unconfirmed');assert.ok(out.headers['X-Content-Type-Options']);
});
for(const uncertain of [undefined,false])test(`T09 round2: legacy route uncertain=${uncertain} retains confirmed success`,async t=>{const f=fixture(t),out=await request(f,{id:f.item.id,ok:true,...(uncertain===undefined?{}:{uncertain})});assert.equal(out.status,200);assert.equal(out.body.item.status,'done');});
test('T09 round2: actual route legacy known-not-sent retains bounded retry',async t=>{const f=fixture(t),out=await request(f,{id:f.item.id,ok:false,error:'synthetic known no-send'});assert.equal(out.status,200);assert.equal(out.body.item.status,'retrying');assert.equal(out.body.item.retryAt,f.clock.now+RETRY_DELAY_MS);});
test('T09 round2: only JSON boolean true opts into uncertain route behavior',async t=>{for(const value of ['true','false',1]){const f=fixture(t),out=await request(f,{id:f.item.id,ok:true,uncertain:value});assert.equal(out.status,200);assert.equal(out.body.item.status,'done');}});
for(const token of [null,'synthetic-wrong-token'])test(`T09 round2: actual route rejects ${token===null?'missing':'wrong'} bridge token before ACK`,async t=>{const f=fixture(t),saved=disk(f),out=await request(f,{id:f.item.id,uncertain:true,token:TOKEN},{token});assert.equal(out.status,403);assert.equal(f.svc.items[0].status,'sending');assert.deepEqual(disk(f),saved);});
test('T09 round2: remote ACK is rejected even when global remote API token passes',async t=>{const f=fixture(t);f.config.server.allowRemote=true;const out=await request(f,{id:f.item.id,uncertain:true},{ip:'203.0.113.5'});assert.equal(out.status,403);assert.equal(f.svc.items[0].status,'sending');});
test('T09 round2: cross-origin ACK still rejected by actual Router security',async t=>{const f=fixture(t),out=await request(f,{id:f.item.id,uncertain:true},{origin:'https://fixture.invalid'});assert.equal(out.status,403);assert.equal(f.svc.items[0].status,'sending');});
test('T09 round2: route contradictory terminal ACK returns409 without persistence changes',async t=>{const f=fixture(t);await request(f,{id:f.item.id,uncertain:true});const saved=disk(f),out=await request(f,{id:f.item.id,ok:true});assert.equal(out.status,409);assert.deepEqual(disk(f),saved);});
test('T09 round2: actual route persistence failure returns503 and leaves claim unresolved',async t=>{
 const f=fixture(t),saved=disk(f),rename=fs.renameSync;t.mock.method(fs,'renameSync',(from,to)=>{if(to===f.svc.file)throw Object.assign(Error('synthetic ack persistence refusal'),{code:'EACCES'});return rename(from,to);});
 const out=await request(f,{id:f.item.id,ok:true,uncertain:true});assert.equal(out.status,503);assert.equal(out.body.ok,false);assert.equal(f.svc.items[0].status,'sending');assert.equal(f.svc.items[0].attempts,0);assert.deepEqual(disk(f),saved);
});
