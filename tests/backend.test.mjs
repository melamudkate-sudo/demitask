import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeSession,validSession} from '../backend/worker.js';
const env={GROQ_API_KEY:'test-only-fake-key',TEAM_CODE:'test-only-fake-team-code'};
const origin='https://melamudkate-sudo.github.io';
const request=(path,body,token)=>new Request('https://worker.example'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
test('session signatures cannot be forged, expire and rotate with the team code',async()=>{
  const now=Date.now(),token=await makeSession('test-only-secret',now);
  assert.ok(await validSession(token,'test-only-secret',now));
  assert.equal(await validSession(token,'another-test-secret',now),false);
  assert.equal(await validSession(token+'x','test-only-secret',now),false);
  assert.equal(await validSession(token,'test-only-secret',now+13*3600000),false);
});
test('unconfigured, cross-origin and unauthenticated calls never reach Groq',async()=>{
  assert.equal((await worker.fetch(new Request('https://worker.example/health',{headers:{Origin:origin}}),{})).status,503);
  assert.equal((await worker.fetch(new Request('https://worker.example/health',{headers:{Origin:'https://untrusted.example'}}),env)).status,403);
  assert.equal((await worker.fetch(request('/chat/completions',{}),env)).status,401);
});
test('team login accepts the team code and returns a signed session, never the provider key',async()=>{
  const bad=await worker.fetch(request('/session',{code:'wrong'}),env);assert.equal(bad.status,401);
  const response=await worker.fetch(request('/session',{code:env.TEAM_CODE}),env);const text=await response.text();
  assert.equal(response.status,200);assert.ok(!text.includes(env.GROQ_API_KEY));assert.ok(await validSession(JSON.parse(text).token,env.TEAM_CODE));
});
test('authenticated callers cannot use arbitrary endpoints or models',async()=>{
  const token=await makeSession(env.TEAM_CODE);
  assert.equal((await worker.fetch(request('/evil-endpoint',{},token),env)).status,404);
  assert.equal((await worker.fetch(request('/chat/completions',{model:'unbounded-model',messages:[]},token),env)).status,400);
});
test('preflight is limited to the known frontend origins and required headers',async()=>{
  const r=await worker.fetch(new Request('https://worker.example/session',{method:'OPTIONS',headers:{Origin:origin}}),env);
  assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin);
  assert.equal(r.headers.get('Access-Control-Allow-Credentials'),null);
});
