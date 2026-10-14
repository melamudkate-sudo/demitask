import { DEFAULT_RULES, DEFAULT_TERMS, EXAMPLE_INPUT, RESPONSE_SCHEMA, escapeHTML as esc, fullTitle, descriptionHTML, descriptionText, normalizeTerms, validateResponse, buildMessages, demoResponse } from './core.js';

const $ = s => document.querySelector(s);
const storage = {
  read(key, fallback) { try { const x = localStorage.getItem(`demitask:${key}`); return x ? JSON.parse(x) : fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(`demitask:${key}`, JSON.stringify(value)); } catch { toast('Браузер не разрешил сохранение. Данные доступны до закрытия вкладки.'); } }
};
let terms = storage.read('terms', DEFAULT_TERMS);
if (!Array.isArray(terms) || !terms.every(t=>t && ['id','term','aliases','note'].every(k=>typeof t[k]==='string'))) terms = structuredClone(DEFAULT_TERMS);
terms = terms.slice(0,40);
let rules = storage.read('rules', DEFAULT_RULES);
if (typeof rules !== 'string') rules = DEFAULT_RULES;
let history = storage.read('history', []);
if (!Array.isArray(history)) history=[];
history = history.filter(x=>x && typeof x.input==='string' && x.result?.task).slice(0,12);
let apiKey = ''; // Deliberately memory-only. Never store credentials in localStorage, exports or Git.
let model = 'openai/gpt-oss-120b';
let mode = 'demo';
let answers = {};
let result = null;
let questions = [];
let busy = false;
let recording = false;
let recorder = null;
let recognition = null;
let mediaStream = null;
let recordTimer = null;
let toastTimer;
let editIndex = null;

const draft = storage.read('draft', {});
if (typeof draft.input==='string') $('#task-input').value=draft.input.slice(0,14000);
$('#subtasks-toggle').checked=Boolean(draft.subtasks);
$('#checklist-toggle').checked=draft.checklist!==false;
$('#smart-toggle').checked=draft.smart!==false;
function options() { return {subtasks:$('#subtasks-toggle').checked,checklist:$('#checklist-toggle').checked,smart:$('#smart-toggle').checked}; }
function persistDraft() { storage.write('draft',{input:$('#task-input').value,...options()}); $('#char-count').textContent=`${$('#task-input').value.length.toLocaleString('ru')} / 14 000`; }
function counters() { $('#dictionary-count').textContent=terms.length; $('#history-count').textContent=history.length; }
function toast(text) { clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,3800); }
function error(text='') { $('#error-box').textContent=text;$('#error-box').hidden=!text; }
function stage(n) { [1,2,3].forEach(i=>{ const node=$(`#step-${i}`);if(node){node.classList.toggle('current',i===n);node.classList.toggle('done',i<n);} }); }
function invalidate() { result=null;answers={};questions=[];$('#questions-card').hidden=true;$('#result-container').hidden=true;$('#empty-preview').hidden=false;$('#result-status').textContent='ОЖИДАЕТ ИДЕЮ';$('#result-status').classList.remove('ready');stage(1);error();persistDraft(); }
function setBusy(value) {
  busy=value;document.body.classList.toggle('busy',value);
  ['#generate-button','#voice-button','#task-input','#smart-toggle','#subtasks-toggle','#checklist-toggle','#example-button','#preview-example','#new-task'].forEach(s=>$(s).disabled=value);
  $('#questions-form').querySelectorAll('button, textarea').forEach(x=>x.disabled=value);
  $('#generate-label').textContent=value?'Собираем вашу задачу…':'Собрать задачу';
}
function setMode(value) {
  mode=value;
  $('#mode-label').textContent=mode==='live'?'Groq подключён':'Деморежим';
  document.querySelectorAll('.connection-dot').forEach(x=>x.classList.toggle('connected',mode==='live'));
  $('#under-button').textContent=mode==='live'?'Исходный текст, ответы и словарь будут отправлены в Groq':'Деморежим · без отправки данных в нейросеть';
}
function inputExample() { if (busy||recording) return;$('#task-input').value=EXAMPLE_INPUT;invalidate();toast('Пример добавлен. Нажмите «Собрать задачу».');$('#task-input').focus(); }

async function groqFetch(path, init) {
  try {
    const response = await fetch(`https://api.groq.com/openai/v1/${path}`, {...init, headers:{...init.headers,Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(60000)});
    if (!response.ok) {
      if (response.status===401||response.status===403) throw new Error('Groq не принял ключ или доступ ограничен. Проверьте ключ и доступность сервиса в настройках.');
      if (response.status===429) throw new Error(`Достигнут лимит Groq. Попробуйте позже${response.headers.get('retry-after')?` (через ${response.headers.get('retry-after')} сек.)`:''} или сократите запрос.`);
      if (response.status===413) throw new Error('Слишком большой запрос или аудиофайл. Сократите запись или исходный текст.');
      if (response.status===400) throw new Error('Groq отклонил запрос. Проверьте модель в настройках или сократите текст и регламент.');
      throw new Error(`Groq временно недоступен (код ${response.status}). Повторите позже.`);
    }
    return await response.json();
  } catch(e) {
    if (e.name==='TimeoutError'||e.name==='AbortError') throw new Error('Groq не ответил за минуту. Исходный текст сохранён — попробуйте ещё раз.');
    if (e instanceof TypeError) throw new Error('Не удалось связаться с Groq. Проверьте интернет и доступность api.groq.com в вашей сети.');
    throw e;
  }
}
async function generate(forceDraft=false) {
  if (busy||recording) return;
  forceDraft=forceDraft||!$('#smart-toggle').checked;
  const input=$('#task-input').value.trim();
  if (!input) { error('Расскажите голосом или напишите, что нужно сделать.');$('#task-input').focus();return; }
  if (mode==='live'&&!apiKey) { openPanel('settings');return; }
  error();setBusy(true);
  try {
    const payload={input,answers,...options(),terms,rules,forceDraft};
    let data;
    if (mode==='demo') data=demoResponse(payload);
    else {
      const response=await groqFetch('chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages:buildMessages(payload),response_format:{type:'json_schema',json_schema:{name:'task_brief',strict:true,schema:RESPONSE_SCHEMA}},max_completion_tokens:4000})});
      const choice=response.choices?.[0];
      if (choice?.finish_reason==='length') throw new Error('Ответ не поместился целиком. Сократите исходный текст или попробуйте без подзадач.');
      try { data=JSON.parse(choice?.message?.content || ''); } catch { throw new Error('Нейросеть вернула некорректный ответ. Попробуйте ещё раз.'); }
      data=validateResponse(data,options());
      if (forceDraft&&data.questions.length) throw new Error('Нейросеть снова запросила уточнения. Добавьте детали в исходный текст и повторите.');
    }
    if (data.questions.length) {
      result=null;$('#result-container').hidden=true;$('#empty-preview').hidden=false;
      questions=data.questions;renderQuestions();stage(2);$('#result-status').textContent='УТОЧНЯЕМ ДЕТАЛИ';
      $('#questions-card').scrollIntoView({behavior:'smooth',block:'nearest'});
    } else {
      questions=[];result=data;$('#questions-card').hidden=true;renderResult();stage(3);saveHistory(input);toast(mode==='demo'?'Демочерновик готов':'Задача готова. Проверьте перед переносом.');
      if (window.innerWidth<951) $('#preview-example').closest('.preview-column').scrollIntoView({behavior:'smooth',block:'start'});
    }
  } catch(e) { error(e.message); } finally { setBusy(false); }
}
function renderQuestions() {
  $('#questions-fields').innerHTML=questions.map((q,i)=>`<div class="question"><label class="field-label" for="answer-${i}">${i+1}. ${esc(q.label)}</label><textarea id="answer-${i}" data-answer="${i}" maxlength="3000" placeholder="${esc(q.hint)}">${esc(answers[q.id] || '')}</textarea></div>`).join('');
  $('#questions-card').hidden=false;
}
function captureAnswers() { questions.forEach((q,i)=>{ answers[q.id]=$(`#answer-${i}`).value.trim(); }); }
function renderTask(task,index) {
  return `<article class="card result-card"><div class="card-heading"><span class="task-tag">${index===0?(result.subtasks.length?'МАТЕРИНСКАЯ ЗАДАЧА':'НАЗВАНИЕ ЗАДАЧИ'):`ПОДЗАДАЧА ${index}`}</span><button class="text-button" data-edit="${index}">Править ↗</button></div>
    <h3 class="result-title">${esc(task.title)}<small>(ЦКП: ${esc(task.outcome)})</small></h3>
    <div class="copy-row"><button class="copy-button" data-copy="title" data-index="${index}">⧉ Название с ЦКП</button><button class="copy-button" data-copy="outcome" data-index="${index}">⧉ Только ЦКП</button></div>
    <div class="result-section"><div class="result-section-heading"><h3>Описание</h3><button class="copy-button" data-copy="description" data-index="${index}">⧉ С форматированием</button></div><div class="rich-description">${descriptionHTML(task)}</div></div>
    ${task.checklist.length?`<div class="result-section"><div class="result-section-heading"><h3>Чек-лист</h3><button class="copy-button" data-copy="checklist" data-index="${index}">⧉ Все пункты</button></div><div class="checklist-title-row"><div class="checklist-name">${esc(task.checklistTitle)}</div><button class="copy-button" data-copy="checklistTitle" data-index="${index}" aria-label="Скопировать название чек-листа">⧉ Название</button></div><ul class="result-checklist">${task.checklist.map((item,i)=>`<li><span>${esc(item)}</span><button class="item-copy" data-copy="item" data-index="${index}" data-item="${i}" aria-label="Скопировать пункт ${i+1}" title="Скопировать пункт">⧉</button></li>`).join('')}</ul></div>`:''}
  </article>`;
}
function renderResult() {
  if (!result?.task) return;
  $('#empty-preview').hidden=true;$('#result-container').hidden=false;
  $('#result-status').textContent=result.warnings.some(w=>w.includes('Деморежим'))?'ДЕМОЧЕРНОВИК':'ГОТОВО К ПРОВЕРКЕ';$('#result-status').classList.add('ready');
  $('#result-container').innerHTML=(result.warnings.length?`<div class="result-note">${result.warnings.map(esc).join('<br>')}</div>`:'')+renderTask(result.task,0)+(result.subtasks.length?`<div class="subtask-label">ПОДЗАДАЧИ · ${result.subtasks.length}</div>`:'')+result.subtasks.map((t,i)=>renderTask(t,i+1)).join('')+`<div class="result-actions"><button class="text-button" id="export-result">↓ Скачать задачу в JSON</button><button class="text-button" id="start-over">＋ Новая задача</button></div>`;
}
function taskAt(index) { return index===0?result.task:result.subtasks[index-1]; }
async function copy(text,html) {
  try {
    if (html&&window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([text],{type:'text/plain'}),'text/html':new Blob([`<html><body><div style="font-family:Arial,sans-serif;font-size:14px">${html}</div></body></html>`],{type:'text/html'})})]);
    } else {
      await navigator.clipboard.writeText(text);
      if (html) { toast('Скопирован обычный текст: этот браузер не поддерживает HTML-буфер.');return; }
    }
    toast(html?'Описание скопировано с форматированием':'Скопировано');
  } catch {
    const area=document.createElement('textarea');area.value=text;area.style.cssText='position:fixed;left:-9999px;top:0';document.body.append(area);area.select();
    const ok=document.execCommand('copy');area.remove();
    if (ok) toast(html?'Скопирован обычный текст. Браузер ограничил форматированный буфер.':'Скопировано');
    else toast('Браузер запретил копирование. Выделите текст и скопируйте вручную.');
  }
}
function saveHistory(input) {
  const item={id:crypto.randomUUID(),date:new Date().toISOString(),input,result:structuredClone(result),answers:structuredClone(answers),options:options()};
  history=[item,...history].slice(0,12);storage.write('history',history);counters();
}
function exportResult() {
  const file=new Blob([JSON.stringify({app:'ДемиТаск',exportedAt:new Date().toISOString(),...result},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(file);const a=document.createElement('a');a.href=url;a.download='demitask-task.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function newTask() { if (busy||recording) return;$('#task-input').value='';invalidate();$('#task-input').focus();window.scrollTo({top:0,behavior:'smooth'}); }

function openPanel(name) {
  const panel=$('#panel-body');editIndex=null;
  const titles={dictionary:'Ваш словарь',rules:'Как ставим задачи',history:'История задач',settings:'Подключение нейросети',help:'Как работает ДемиТаск'};
  $('#panel-title').textContent=titles[name]||'Редактировать задачу';
  if (name==='help') {
    panel.innerHTML=`<p class="panel-intro">Расскажите о работе своими словами. ДемиТаск поможет превратить мысль в понятную задачу для Битрикс24.</p><section class="help-section"><h3>1. Напишите или наговорите</h3><p>Добавьте контекст, желаемый результат и важные требования. Сроки и исполнителя сервис не запрашивает.</p></section><section class="help-section"><h3>2. Выберите способ постановки</h3><p><strong>Умная постановка</strong> задаст до трёх уточняющих вопросов, если не хватает деталей. Без галочки сразу получится черновик с пометками о пробелах. <strong>Подзадачи</strong> разделят работу на самостоятельные этапы с общим результатом.</p></section><section class="help-section"><h3>3. Проверьте и скопируйте</h3><p>Название начинается с действия и заканчивается «(ЦКП: конечный продукт)». Описание копируется с заголовками и списками. Чек-лист, его название и каждый пункт копируются отдельно. Формулировки можно изменить через «Править».</p></section><section class="help-section"><h3>Словарь, регламент и история</h3><p><strong>Словарь</strong> хранит правильные названия моделей и термины. <strong>Регламент</strong> задаёт правила составления задач. В <strong>истории</strong> — последние 12 результатов. Данные сохраняются только в этом браузере.</p></section><section class="help-section"><h3>Демо и настоящая нейросеть</h3><p>Без ключа работает шаблонный деморежим — начните с кнопки «Попробовать на примере». Для произвольных задач подключите бесплатный ключ Groq в «Подключение AI». Ключ после перезагрузки нужно ввести снова. В режиме Groq текст и аудио передаются провайдеру.</p></section>`;
  } else if (name==='dictionary') {
    panel.innerHTML=`<p class="panel-intro">Правильные названия моделей, характеристики и рабочие термины. Словарь помогает распознавать речь и сохранять нужные формулировки.</p><form id="term-form"><div class="form-field"><label for="term-name">Правильное название</label><input id="term-name" required maxlength="80" placeholder="Например, Luna S"></div><div class="form-field"><label for="term-aliases">Как это может звучать или распознаваться</label><input id="term-aliases" maxlength="250" placeholder="луна эс, люна с — через запятую"></div><div class="form-field"><label for="term-note">Пояснение или характеристики</label><textarea id="term-note" maxlength="600" placeholder="Что важно знать об этой модели"></textarea></div><button class="primary-button">＋ Добавить в словарь</button></form><div class="dictionary-list">${terms.map(t=>`<div class="term-card"><div class="term-top"><strong>${esc(t.term)}</strong><button class="delete-button" data-delete-term="${esc(t.id)}">Удалить</button></div><p>${esc(t.aliases)}</p><p>${esc(t.note)}</p></div>`).join('')||'<p class="muted">Пока пусто. Добавьте первый термин.</p>'}</div><p class="muted">До 40 записей. Словарь хранится в этом браузере и передаётся Groq при обработке. Характеристики используются как контекст, а не добавляются во все задачи автоматически.</p>`;
  } else if (name==='rules') {
    panel.innerHTML=`<p class="panel-intro">Это ваш регламент. Нейросеть получает его при каждом запросе. В деморежиме используется фиксированный шаблон.</p><form id="rules-form"><div class="form-field"><label for="rules-text">Правила постановки</label><textarea id="rules-text" class="rules-text" maxlength="12000" required>${esc(rules)}</textarea></div><div class="panel-actions"><button class="primary-button">Сохранить регламент</button><button type="button" class="text-button" id="reset-rules">Базовый вариант</button></div></form>`;
  } else if (name==='history') {
    panel.innerHTML=`<p class="panel-intro">Последние 12 собранных задач. Хранятся только в этом браузере. Исходные мысли и результаты не публикуются на GitHub.</p>${history.map(h=>`<button class="history-item" data-history="${esc(h.id)}"><strong>${esc(h.result.task.title)}</strong><small>${esc(new Date(h.date).toLocaleString('ru-RU',{dateStyle:'medium',timeStyle:'short'}))} · ${h.result.subtasks?.length||0} подзадач</small></button>`).join('')||'<div class="panel-box">Соберите первую задачу — она появится здесь.</div>'}${history.length?'<button class="text-button" id="clear-history">Очистить историю в этом браузере</button>':''}`;
  } else if (name==='settings') {
    panel.innerHTML=`<p class="panel-intro">Для прототипа подойдёт бесплатный тариф Groq: одна учётная запись для составления задач и распознавания речи.</p><div class="panel-box">1. Откройте <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">Groq → API Keys ↗</a><br>2. Создайте ключ и вставьте его ниже.<br>3. Выберите «Подключить Groq».<br><a href="https://console.groq.com/docs/rate-limits" target="_blank" rel="noopener noreferrer">Бесплатные квоты и текущие ограничения ↗</a></div><form id="settings-form"><div class="form-field"><label for="api-key">Ваш API-ключ Groq</label><input id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="${apiKey?'Ключ уже введён; пусто — оставить текущий':'gsk_…'}"><small>Ключ живёт только в памяти этой вкладки и отправляется напрямую api.groq.com. После перезагрузки его нужно ввести снова. В код, историю и хранилище браузера он не записывается.</small></div><div class="form-field"><label for="model-select">Модель для задач</label><select id="model-select"><option value="openai/gpt-oss-120b">GPT OSS 120B · основной вариант</option><option value="openai/gpt-oss-20b">GPT OSS 20B · компактнее</option><option value="qwen/qwen3.8-27b">Qwen 3.8 27B · альтернатива</option></select></div><div class="panel-actions"><button class="primary-button">Подключить Groq</button><button type="button" class="text-button" id="demo-mode">Деморежим</button></div><p class="muted">Подключение проверяется при первом запросе. В режиме Groq исходная мысль, ответы, регламент, словарь и записанное аудио передаются провайдеру. Квоты и доступность зависят от аккаунта и региона. Для общего сервиса с одним ключом понадобится серверный прокси с авторизацией.</p><p class="muted">Без ключа голосовой ввод доступен через распознавание браузера, если оно поддерживается; речь может обрабатываться сервисом браузера. С ключом запись распознаёт Whisper, словарь передаётся как подсказка.</p></form>`;
    $('#model-select').value=model;
  }
  if (!$('#panel-dialog').open) $('#panel-dialog').showModal();
}
function editTask(index) {
  editIndex=index;const t=taskAt(index);$('#panel-title').textContent=index?'Править подзадачу':'Править задачу';
  $('#panel-body').innerHTML=`<form id="edit-form"><p class="panel-intro">Уточните формулировки перед переносом. В списках каждый пункт — с новой строки.</p>${[['title','Что сделать'],['outcome','ЦКП: что получаем'],['context','Контекст'],['steps','Что сделать — по пунктам'],['requirements','Требования и материалы'],['acceptance','Критерии приёмки'],['checklistTitle','Название чек-листа'],['checklist','Пункты чек-листа']].map(([key,label])=>`<div class="form-field"><label for="edit-${key}">${label}</label><textarea id="edit-${key}" maxlength="6000" ${['title','outcome'].includes(key)?'required':''}>${esc(Array.isArray(t[key])?t[key].join('\n'):t[key])}</textarea></div>`).join('')}<button class="primary-button">Сохранить изменения</button></form>`;
  $('#panel-dialog').showModal();
}

function voiceState(active,kind='') {
  recording=active;$('#voice-button').classList.toggle('recording',active);
  $('#voice-label').textContent=active?'Запись идёт · нажмите, чтобы закончить':'Просто расскажите голосом';
  $('#voice-hint').textContent=active?(kind==='groq'?'До 3 минут · затем распознаем через Whisper':'Говорите — текст появится ниже'):'Нажмите, чтобы начать запись';
  ['#generate-button','#task-input','#smart-toggle','#subtasks-toggle','#checklist-toggle','#example-button','#preview-example','#new-task'].forEach(s=>$(s).disabled=active);
}
function stopStream() {clearTimeout(recordTimer);mediaStream?.getTracks().forEach(t=>t.stop());mediaStream=null;}
function appendVoice(text) {
  const value=normalizeTerms(text,terms).trim();if(!value) {error('Речь не распознана. Попробуйте ещё раз или введите текст.');return;}
  const combined=[$('#task-input').value.trim(),value].filter(Boolean).join('\n');
  $('#task-input').value=combined.slice(0,14000);invalidate();
  if(combined.length>14000) error('Достигнут лимит текста — сохранены первые 14 000 символов.');
}
async function startVoice() {
  if (busy) return;
  if (recording) { if(recorder?.state==='recording') recorder.stop();recognition?.stop();return; }
  error();
  if (mode==='live'&&apiKey) {
    if (!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder) {error('Этот браузер не поддерживает запись. Откройте страницу в современном Chrome, Edge или Safari.');return;}
    // Lock immediately to prevent parallel permission requests on a double click.
    $('#voice-button').disabled=true;
    try {
      mediaStream=await navigator.mediaDevices.getUserMedia({audio:true});
      const mimeType=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
      recorder=new MediaRecorder(mediaStream,mimeType?{mimeType}:{});const chunks=[];let size=0;
      recorder.ondataavailable=e=>{ if(e.data.size){chunks.push(e.data);size+=e.data.size;if(size>23*1024*1024&&recorder.state==='recording')recorder.stop();} };
      recorder.onerror=()=>{stopStream();voiceState(false);error('Запись прервалась. Проверьте микрофон и повторите.');};
      recorder.onstop=async()=>{
        stopStream();voiceState(false);setBusy(true);$('#voice-label').textContent='Распознаём запись…';
        try {
          const blob=new Blob(chunks,{type:recorder.mimeType});
          if(blob.size>25*1024*1024)throw new Error('Запись больше 25 МБ. Запишите более короткое сообщение.');
          const form=new FormData();form.append('file',blob,`voice.${blob.type.includes('mp4')?'mp4':blob.type.includes('ogg')?'ogg':'webm'}`);form.append('model','whisper-large-v3-turbo');form.append('language','ru');form.append('response_format','json');
          form.append('prompt',terms.map(t=>t.term).join(', ').slice(0,550));
          const data=await groqFetch('audio/transcriptions',{method:'POST',body:form});appendVoice(data.text||'');
        } catch(e) {error(e.message);} finally {setBusy(false);voiceState(false);recorder=null;}
      };
      recorder.start(1000);voiceState(true,'groq');recordTimer=setTimeout(()=>{if(recorder?.state==='recording')recorder.stop();},180000);
    } catch(e) {stopStream();voiceState(false);error(e.name==='NotAllowedError'?'Нет доступа к микрофону. Разрешите его для этой страницы в настройках браузера.':e.name==='NotFoundError'?'Микрофон не найден. Подключите микрофон и попробуйте снова.':'Не удалось начать запись. Проверьте микрофон и разрешения браузера.');}
    finally {$('#voice-button').disabled=false;}
  } else {
    const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
    if (!Speech) {error('Для голосового ввода в этом браузере подключите Groq в настройках. Либо откройте страницу в Chrome/Edge с поддержкой распознавания речи.');return;}
    recognition=new Speech();recognition.lang='ru-RU';recognition.continuous=true;recognition.interimResults=false;
    let spoken='';recognition.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal)spoken+=e.results[i][0].transcript+' ';};
    recognition.onerror=e=>{error(e.error==='not-allowed'?'Разрешите доступ к микрофону в настройках браузера.':'Браузер не смог распознать речь. Повторите или подключите Groq.');};
    recognition.onend=()=>{voiceState(false);if(spoken.trim())appendVoice(spoken);recognition=null;};
    try{recognition.start();voiceState(true);}catch{error('Не удалось запустить распознавание речи. Попробуйте ещё раз.');}
  }
}

$('#task-input').addEventListener('input',invalidate);
$('#subtasks-toggle').addEventListener('change',invalidate);
$('#checklist-toggle').addEventListener('change',invalidate);
$('#smart-toggle').addEventListener('change',invalidate);
$('#example-button').addEventListener('click',inputExample);
$('#preview-example').addEventListener('click',inputExample);
$('#generate-button').addEventListener('click',()=>generate());
$('#voice-button').addEventListener('click',startVoice);
$('#new-task').addEventListener('click',newTask);
$('#studio-nav').addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'}));
$('#questions-form').addEventListener('submit',e=>{e.preventDefault();captureAnswers();generate(true);});
$('#skip-questions').addEventListener('click',()=>{captureAnswers();generate(true);});
$('#close-panel').addEventListener('click',()=>$('#panel-dialog').close());
$('#panel-dialog').addEventListener('click',e=>{if(e.target===$('#panel-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
document.addEventListener('click',async e=>{
  const button=e.target.closest('button');if(!button)return;
  if(button.dataset.panel){openPanel(button.dataset.panel);return;}
  if(button.dataset.copy&&result){const t=taskAt(Number(button.dataset.index));const kind=button.dataset.copy;const values={title:fullTitle(t),outcome:`ЦКП: ${t.outcome}`,description:descriptionText(t),checklist:t.checklist.join('\n'),checklistTitle:t.checklistTitle,item:t.checklist[Number(button.dataset.item)]};await copy(values[kind],kind==='description'?descriptionHTML(t):null);return;}
  if(button.dataset.edit!==undefined&&result){editTask(Number(button.dataset.edit));return;}
  if(button.id==='export-result')exportResult();
  if(button.id==='start-over')newTask();
  if(button.dataset.deleteTerm){terms=terms.filter(t=>t.id!==button.dataset.deleteTerm);storage.write('terms',terms);counters();openPanel('dictionary');}
  if(button.id==='reset-rules')$('#rules-text').value=DEFAULT_RULES;
  if(button.id==='demo-mode'){if(busy||recording){toast('Сначала завершите текущую операцию.');return;}apiKey='';setMode('demo');$('#panel-dialog').close();toast('Деморежим включён. Ключ удалён из памяти.');}
  if(button.id==='clear-history'){history=[];storage.write('history',history);counters();openPanel('history');}
  if(button.dataset.history){
    if(busy||recording){toast('Сначала завершите текущую обработку.');return;}
    const item=history.find(x=>x.id===button.dataset.history);if(!item)return;
    try{const restored=validateResponse(item.result,item.options||{});$('#task-input').value=item.input;$('#subtasks-toggle').checked=Boolean(item.options?.subtasks);$('#checklist-toggle').checked=item.options?.checklist!==false;$('#smart-toggle').checked=item.options?.smart!==false;invalidate();result=restored;answers=item.answers||{};renderResult();stage(3);$('#panel-dialog').close();persistDraft();}catch{toast('Эту запись не удалось восстановить.');}
  }
});
$('#panel-body').addEventListener('submit',e=>{
  e.preventDefault();
  if(e.target.id==='term-form'){
    if(terms.length>=40){toast('В словаре уже 40 записей. Удалите ненужные.');return;}
    const term=$('#term-name').value.trim();if(!term)return;
    if(terms.some(t=>t.term.toLowerCase()===term.toLowerCase())){toast('Такой термин уже есть. Удалите старую запись для замены.');return;}
    terms.push({id:crypto.randomUUID(),term,aliases:$('#term-aliases').value.trim(),note:$('#term-note').value.trim()});storage.write('terms',terms);counters();openPanel('dictionary');toast('Термин добавлен');
  }
  if(e.target.id==='rules-form'){rules=$('#rules-text').value.trim();if(!rules)return;storage.write('rules',rules);$('#panel-dialog').close();toast('Регламент сохранён');}
  if(e.target.id==='settings-form'){
    if(recording||busy){toast('Дождитесь завершения текущей операции.');return;}
    const key=$('#api-key').value.trim();if(key)apiKey=key;
    if(!apiKey){toast('Введите API-ключ Groq или выберите деморежим.');return;}
    model=$('#model-select').value;setMode('live');$('#api-key').value='';$('#panel-dialog').close();toast('Groq выбран. Ключ проверится при первом запросе.');
  }
  if(e.target.id==='edit-form'&&editIndex!==null){
    const t=taskAt(editIndex);const updated={};
    for(const key of ['title','outcome','context','steps','requirements','acceptance','checklistTitle','checklist']){
      const value=$(`#edit-${key}`).value.trim();updated[key]=Array.isArray(t[key])?value.split('\n').map(x=>x.trim()).filter(Boolean):value;
    }
    if(updated.checklist.length&&!updated.checklistTitle){toast('Добавьте название чек-листа.');return;}
    Object.assign(t,updated);$('#panel-dialog').close();renderResult();saveHistory($('#task-input').value.trim());toast('Изменения сохранены');
  }
});
window.addEventListener('pagehide',()=>{recognition?.abort();if(recorder?.state==='recording'){recorder.onstop=null;recorder.stop();}stopStream();apiKey='';});
persistDraft();counters();setMode('demo');
