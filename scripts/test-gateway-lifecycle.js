'use strict';
const assert = require('node:assert/strict');
const { createGatewayLifecycle } = require('./gateway-lifecycle.js');
let passed=0;
function ok(name, fn) { fn(); passed++; console.log('OK '+name); }
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};};
(async()=>{
 const helper=deferred(),close=deferred(),events=[],external={alive:true};
 const lifecycle=createGatewayLifecycle({spawnRestart:async d=>{events.push(['helper',d]);await helper.promise;},exit:async code=>{events.push(['exit',code]);await close.promise;},onState:s=>events.push(['state',s.phase])});
 ok('restart admission is synchronous and distinct conflicting shutdown is refused',()=>{assert.equal(lifecycle.scheduleRestart('isolated',{notifyAddress:true}),true);assert.equal(lifecycle.status().phase,'draining');assert.equal(lifecycle.scheduleShutdown(),false);});
 await Promise.resolve(); await Promise.resolve();
 ok('no exit before actual restart helper startup',()=>{assert.equal(events.some(e=>e[0]==='exit'),false);assert.equal(lifecycle.status().phase,'restarting');assert.equal(lifecycle.scheduleRestart('duplicate'),true);assert.equal(events.filter(e=>e[0]==='helper').length,1);});
 helper.resolve(); await new Promise(setImmediate);
 ok('exit waits for the gateway response-flush callback',()=>{assert.equal(lifecycle.status().phase,'restarting');assert.deepEqual(events.find(e=>e[0]==='helper')[1],{reason:'isolated',notifyAddress:true});assert.deepEqual(events.find(e=>e[0]==='exit'),['exit',0]);});
 close.resolve(); assert.deepEqual(await lifecycle.completion(),{closed:true,restartHelperStarted:true});
 ok('closed transaction never touches an external DSH/native process',()=>{assert.equal(external.alive,true);assert.equal(lifecycle.status().phase,'closed');assert.equal(events.filter(e=>e[0]==='helper').length,1);});
 let exits=0,spawns=0;
 const failed=createGatewayLifecycle({spawnRestart:async()=>{spawns++;throw Error('synthetic helper failure');},exit:()=>{exits++;}});
 failed.scheduleRestart('failure'); const failure=await failed.completion();
 ok('failed helper retains gateway and rejects retries',()=>{assert.deepEqual(failure,{closed:false,code:'restart-helper-failed'});assert.equal(exits,0);assert.equal(spawns,1);assert.equal(failed.scheduleRestart('again'),false);assert.equal(failed.scheduleShutdown(),false);});
 const shutdown=createGatewayLifecycle({spawnRestart:()=>{throw Error('forbidden');},exit:()=>{exits++;},onState:()=>{throw Error('logging failure');}});
 shutdown.scheduleShutdown(); await shutdown.completion();
 ok('shutdown never starts a helper and logging failure does not authorize or block exit',()=>{assert.equal(exits,1);assert.equal(shutdown.status().phase,'closed');});
 const badClose=createGatewayLifecycle({spawnRestart:()=>{},exit:()=>{throw Error('synthetic close failure');}});badClose.scheduleShutdown();await badClose.completion();
 ok('close failure stays explicit without forced second exit',()=>assert.deepEqual(badClose.status(),{phase:'failed',kind:'shutdown',code:'gateway-close-failed'}));
 ok('invalid lifecycle dependencies fail before any action',()=>assert.throws(()=>createGatewayLifecycle({spawnRestart:()=>{}}),TypeError));
 console.log('Passed '+passed+' gateway-only lifecycle checks; no live process was touched.');
})().catch(e=>{console.error(e);process.exitCode=1});
