import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { once } from 'node:events';
import selfsigned from 'selfsigned';
import { createPortService, loadPortServices } from '../src/port-services.js';
import { createHandler } from '../src/services/json-line.js';
import { createHandler as createHttp } from '../src/services/http-json.js';
const pem = selfsigned.generate([{name:'commonName',value:'dapt.iptime.org'}], {keySize:2048, algorithm:'sha256', extensions:[{name:'basicConstraints',cA:true},{name:'subjectAltName',altNames:[{type:2,value:'dapt.iptime.org'}]}]});
const tlsOptions = {key:pem.private,cert:pem.cert};
async function listen(t, server) {
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}
const connect = (port) => tls.connect({host:'127.0.0.1',port,servername:'dapt.iptime.org',ca:pem.cert});

test('TLS proxy terminates client TLS and forwards to plain TCP or verified TLS origin', async (t) => {
  for (const encrypted of [false,true]) {
    const upstream = encrypted ? tls.createServer(tlsOptions,(s)=>s.pipe(s)) : net.createServer((s)=>s.pipe(s));
    const target = await listen(t,upstream);
    let resolutions = 0;
    const server = await createPortService({config:{port:20622,mode:'proxy',transport:'tls',upstream:{host:'dapt.iptime.org',port:target,transport:encrypted?'tls':'tcp',ca:pem.cert}},tlsOptions,
      lookup(_host,_options,callback) {resolutions++; callback(null,'127.0.0.1',4);} });
    const port = await listen(t,server);
    const client = connect(port); await once(client,'secureConnect');
    const reply = once(client,'data'); client.write('test'); assert.equal((await reply)[0].toString(),'test');
    client.end(); await once(client,'close'); assert.equal(resolutions,1);
  }
});

test('TLS simulation handles fragmented/coalesced commands and isolates port state', async (t) => {
  const server = await createPortService({config:{port:20622,mode:'simulate',transport:'tls',protocol:'stream',factory:createHandler},tlsOptions});
  const port = await listen(t,server); const client = connect(port); await once(client,'secureConnect');
  let buffer=''; const replies=[];
  const done = new Promise((resolve)=>client.on('data',(chunk)=>{buffer+=chunk; let i; while((i=buffer.indexOf('\n'))>=0){replies.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);if(replies.length===3)resolve();}}));
  client.write('{"op":"se');client.write('t","key":"power","value":true}\n{"op":"get","key":"power"}\n{"op":"ping"}\n');
  await done; assert.equal(replies[1].value,true);assert.equal(replies[2].value,'pong');
  client.end();await once(client,'close');
});

test('HTTPS simulation and module validation, all per-port modules load',async(t)=>{
  const server=await createPortService({config:{port:8090,mode:'simulate',transport:'tls',protocol:'http',factory:createHttp},tlsOptions});
  const port=await listen(t,server);
  const body=await new Promise((resolve,reject)=>https.get({host:'127.0.0.1',port,path:'/health',servername:'dapt.iptime.org',ca:pem.cert,agent:false},(res)=>{let data='';res.on('data',(v)=>data+=v);res.on('end',()=>resolve(JSON.parse(data)));}).on('error',reject));
  assert.deepEqual(body,{ok:true,port:8090,service:'bridge-simulator'});
  const example='src/services/all-ports.example.json';
  const ports=Object.keys(JSON.parse(fs.readFileSync(example))).map(Number);
  assert.equal(Object.keys(await loadPortServices(example,ports)).length,24);
  await assert.rejects(loadPortServices(example,[]),/not an enabled/);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'port-service-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json');
  fs.writeFileSync(file,JSON.stringify({20622:{mode:'proxy',transport:'tls',upstream:{host:'127.0.0.1',port:20622}}}));
  await assert.rejects(loadPortServices(file,[20622]),/loops/);
});

test('TLS proxy rejects an untrusted upstream certificate and closes client', async(t)=>{
  const upstream=tls.createServer(tlsOptions,(socket)=>socket.pipe(socket));
  const target=await listen(t,upstream);
  let error;
  const server=await createPortService({config:{port:8883,mode:'proxy',transport:'tls',upstream:{host:'127.0.0.1',port:target,transport:'tls',servername:'dapt.iptime.org'}},tlsOptions,onError:(value)=>{error=value;}});
  const port=await listen(t,server);
  const client=connect(port);await once(client,'secureConnect');
  await once(client,'close');
  assert.ok(error);assert.match(error.message,/certificate/i);
});

test('simulation async handler errors return HTTP 500 instead of crashing',async(t)=>{
  const server=await createPortService({config:{port:8090,mode:'simulate',transport:'tls',protocol:'http',factory:()=>async()=>{throw new Error('failure');}},tlsOptions});
  const port=await listen(t,server);
  const status=await new Promise((resolve,reject)=>https.get({host:'127.0.0.1',port,servername:'dapt.iptime.org',ca:pem.cert,agent:false},(res)=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject));
  assert.equal(status,500);
});
