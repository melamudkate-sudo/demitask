// Cloudflare Worker. Secrets GROQ_API_KEY and TEAM_CODE are configured in Cloudflare, never in Git.
const ORIGINS=new Set(['https://melamudkate-sudo.github.io','http://127.0.0.1:4173','http://localhost:4173']);
const MODELS=new Set(['openai/gpt-oss-120b','openai/gpt-oss-20b','qwen/qwen3.8-27b']);
const windows=new Map();
const bytes=new TextEncoder();
const encode=data=>btoa(String.fromCharCode(...new Uint8Array(data))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function decode(value){return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
async function signingKey(secret){return crypto.subtle.importKey('raw',bytes.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function makeSession(secret,now=Date.now()){
  const payload=encode(bytes.encode(JSON.stringify({exp:now+12*60*60*1000,nonce:crypto.randomUUID()})));
  const signature=encode(await crypto.subtle.sign('HMAC',await signingKey(secret),bytes.encode(payload)));
  return payload+'.'+signature;
}
export async function validSession(token,secret,now=Date.now()){
  try{const [payload,signature,...extra]=token.split('.');if(extra.length)return false;
    if(!await crypto.subtle.verify('HMAC',await signingKey(secret),decode(signature),bytes.encode(payload)))return false;
    const parsed=JSON.parse(new TextDecoder().decode(decode(payload)));return Number.isFinite(parsed.exp)&&parsed.exp>now&&parsed.exp<=now+12*60*60*1000;
  }catch{return false;}
}
function throttle(key,limit,period=60000){
  const now=Date.now();const window=windows.get(key);
  if(!window||now-window.start>=period){windows.set(key,{start:now,count:1});return true;}
  if(window.count>=limit)return false;window.count++;return true;
}
function response(value,status,origin,extra={}){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':origin,'Vary':'Origin',...extra}});}
export default {
  async fetch(request,env){
    const origin=request.headers.get('Origin')||'';const path=new URL(request.url).pathname;
    if(!ORIGINS.has(origin))return response({error:'Origin denied'},403,'null');
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Max-Age':'3600','Vary':'Origin'}});
    if(!env.GROQ_API_KEY||!env.TEAM_CODE)return response({error:'Сервер ещё не настроен владельцем.'},503,origin);
    if(request.method==='GET'&&path==='/health')return response({ready:true},200,origin);
    if(request.method!=='POST')return response({error:'Method not allowed'},405,origin);
    const ip=request.headers.get('CF-Connecting-IP')||'local';
    // These limits are per-isolate, best effort. Authentication is enforced cryptographically;
    // provider-wide hard quotas are enforced by Groq Free. Never rely on CORS as authentication.
    if(windows.size>10000)for(const [k,v] of windows)if(Date.now()-v.start>3600000)windows.delete(k);
    if(path==='/session'){
      if(!throttle('login:'+ip,8,600000))return response({error:'Слишком много попыток входа. Повторите через 10 минут.'},429,origin,{'Retry-After':'600'});
      if(Number(request.headers.get('Content-Length')||0)>1024)return response({error:'Request too large'},413,origin);
      const text=await request.text();if(text.length>1024)return response({error:'Request too large'},413,origin);
      let code;try{code=JSON.parse(text).code;}catch{return response({error:'Некорректный запрос'},400,origin);}
      if(typeof code!=='string'||code!==env.TEAM_CODE)return response({error:'Неверный код команды.'},401,origin);
      return response({token:await makeSession(env.TEAM_CODE)},200,origin);
    }
    if(!await validSession((request.headers.get('Authorization')||'').replace(/^Bearer /,''),env.TEAM_CODE))return response({error:'Введите код команды для входа.'},401,origin);
    if(!['/chat/completions','/audio/transcriptions'].includes(path))return response({error:'Not found'},404,origin);
    if(!throttle('api:'+ip,20))return response({error:'Слишком много запросов. Подождите минуту.'},429,origin,{'Retry-After':'60'});
    try{
      let body;let headers={Authorization:`Bearer ${env.GROQ_API_KEY}`};
      if(path==='/chat/completions'){
        if(Number(request.headers.get('Content-Length')||0)>250000)return response({error:'Слишком большой запрос. Текст не обрезан: разделите задачу.'},413,origin);
        const text=await request.text();if(text.length>125000)return response({error:'Слишком большой запрос. Текст не обрезан: разделите задачу.'},413,origin);
        let data;try{data=JSON.parse(text);}catch{return response({error:'Некорректный JSON'},400,origin);}
        if(!MODELS.has(data.model)||!Array.isArray(data.messages)||data.messages.length>4||!data.messages.every(m=>['system','user'].includes(m.role)&&typeof m.content==='string'))return response({error:'Некорректная структура запроса'},400,origin);
        body=JSON.stringify({model:data.model,messages:data.messages,response_format:data.response_format,max_completion_tokens:Math.min(Number(data.max_completion_tokens)||3000,4000)});
        headers['Content-Type']='application/json';
      }else{
        if(Number(request.headers.get('Content-Length')||0)>25*1024*1024)return response({error:'Фрагмент больше 25 МБ.'},413,origin);
        const form=await request.formData();const file=form.get('file');
        if(!file||typeof file==='string'||file.size>25*1024*1024)return response({error:'Неверный аудиофайл.'},400,origin);
        body=new FormData();body.set('file',file);body.set('model','whisper-large-v3-turbo');body.set('language','ru');body.set('response_format','json');body.set('prompt',String(form.get('prompt')||'').slice(0,650));
      }
      const upstream=await fetch('https://api.groq.com/openai/v1'+path,{method:'POST',headers,body,signal:AbortSignal.timeout(90000)});
      const text=await upstream.text();
      // Do not forward provider errors verbatim or include secrets in logs/responses.
      if(!upstream.ok)return response({error:upstream.status===429?'Достигнута бесплатная квота Groq. Повторите позже.':'Groq не смог выполнить запрос.'},upstream.status,origin,{'Retry-After':upstream.headers.get('retry-after')||'60'});
      return new Response(text,{status:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':origin,'Vary':'Origin'}});
    }catch{return response({error:'Сервис временно недоступен. Исходные данные сохранены в браузере.'},502,origin);}
  }
};
