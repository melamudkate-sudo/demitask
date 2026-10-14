import { sanitizeRichHTML, richText } from './rich-text.js';
import { DEFAULT_RULES, DEFAULT_TERMS, EXAMPLE_INPUT, RESPONSE_SCHEMA, escapeHTML as esc, fullTitle, descriptionHTML, descriptionText, normalizeTerms, validateResponse, buildMessages, demoResponse, buildRevisionMessages } from './core.js';
import { GLOSSARY_VERSION, migrateTerms, speechGlossary } from './glossary.js';
import { assessQuality } from './quality.js';
import { SegmentedCapture, collectSpeechResults, joinSegments, mergeTranscript } from './voice.js';
import { TEAM_API_BASE } from './config.js';

const $ = s => document.querySelector(s);
const storage = {
  read(key, fallback) { try { const x = localStorage.getItem(`demitask:${key}`); return x ? JSON.parse(x) : fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(`demitask:${key}`, JSON.stringify(value)); } catch { queueMicrotask(()=>toast('Браузер не разрешил сохранение. Данные доступны до закрытия вкладки.')); } }
};
let terms = migrateTerms(storage.read('terms', null),storage.read('glossary-version',0),storage.read('removed-terms',[]));
storage.write('terms',terms);storage.write('glossary-version',GLOSSARY_VERSION);
let rules = storage.read('rules', DEFAULT_RULES);
if (typeof rules !== 'string') rules = DEFAULT_RULES;
let history = storage.read('history', []);
if (!Array.isArray(history)) history=[];
history = history.filter(x=>x && typeof x.input==='string' && x.result?.task).slice(0,12);
let apiKey = ''; // Deliberately memory-only. Never store credentials in localStorage, exports or Git.
let model = 'openai/gpt-oss-120b';
let mode = TEAM_API_BASE?'team':'demo';
let teamSession='';try{teamSession=sessionStorage.getItem('demitask:team-session')||'';}catch{}
let browserUnavailable=false;
let voiceEngine='browser';
let answers = {};
let result = null;
let questions = [];
let busy = false;
let recording = false;
let capture = null;
let voiceTarget='task-input';
let voiceBase='';
let voiceJobs=[];
let voiceProcessing=false;
let voiceFinishing=false;
let partialAccepted=false;
let voiceStartedAt=0;
let browserSpoken='';
let browserCommitted='';
let browserEndResolve=null;
let recognition = null;
let mediaStream = null;
let recordTimer = null;
let toastTimer;
let inlineEditIndex=null;
let inlineOriginal=null;
let revisionPending=false;
let revisionDraft=null;

const draft = storage.read('draft', {});
if (typeof draft.input==='string') $('#task-input').value=draft.input;
$('#subtasks-toggle').checked=Boolean(draft.subtasks);
$('#checklist-toggle').checked=draft.checklist!==false;
$('#smart-toggle').checked=draft.smart!==false;
function options() { return {subtasks:$('#subtasks-toggle').checked,checklist:$('#checklist-toggle').checked,smart:$('#smart-toggle').checked}; }
function persistDraft() { storage.write('draft',{input:$('#task-input').value,...options(),questions,answers}); $('#char-count').textContent=`${$('#task-input').value.length.toLocaleString('ru')} знаков`; }
function counters() { $('#dictionary-count').textContent=terms.length; $('#history-count').textContent=history.length; }
function toast(text) { clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,3800); }
function error(text='') { $('#error-box').textContent=text;$('#error-box').hidden=!text; }
function stage(n) { [1,2,3].forEach(i=>{ const node=$(`#step-${i}`);if(node){node.classList.toggle('current',i===n);node.classList.toggle('done',i<n);} }); }
function invalidate() { inlineEditIndex=null;inlineOriginal=null;result=null;answers={};questions=[];$('#questions-card').hidden=true;$('#result-container').hidden=true;$('#empty-preview').hidden=false;$('#result-status').textContent='ОЖИДАЕТ ИДЕЮ';$('#result-status').classList.remove('ready');stage(1);error();persistDraft(); }
function setBusy(value) {
  busy=value;document.body.classList.toggle('busy',value);
  ['#generate-button','#voice-button','#task-input','#smart-toggle','#subtasks-toggle','#checklist-toggle','#example-button','#preview-example','#new-task'].forEach(s=>$(s).disabled=value);
  $('#questions-form').querySelectorAll('button, textarea').forEach(x=>x.disabled=value);
  $('#generate-label').textContent=value?'Собираем вашу задачу…':'Собрать задачу';
}
function setMode(value) {
  mode=value;
  $('#mode-label').textContent=mode==='team'?(teamSession?'Командный доступ':'Войти в команду'):mode==='live'?'Groq подключён':'Деморежим';
  document.querySelectorAll('.connection-dot').forEach(x=>x.classList.toggle('connected',mode==='live'||(mode==='team'&&Boolean(teamSession))));
  $('#under-button').textContent=mode==='team'?'Задачи обрабатываются через общий доступ команды':mode==='live'?'Исходный текст, ответы и словарь будут отправлены в Groq':'Деморежим · без отправки данных в нейросеть';
}
function inputExample() { if (busy||recording||voicePending()) return;$('#task-input').value=EXAMPLE_INPUT;invalidate();toast('Пример добавлен. Нажмите «Собрать задачу».');$('#task-input').focus(); }

async function connectTeam() {
  if(busy||recording||voicePending())return;
  const code=$('#team-code').value.trim();if(!code)return;
  const button=$('#team-form button');button.disabled=true;
  try{
    const response=await fetch(TEAM_API_BASE+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:AbortSignal.timeout(15000)});
    const data=await response.json();if(!response.ok||!data.token)throw new Error(data.error||'Не удалось войти в команду.');
    teamSession=data.token;try{sessionStorage.setItem('demitask:team-session',teamSession);}catch{}$('#team-code').value='';setMode('team');$('#panel-dialog').close();toast('Общий доступ подключён');
  }catch(e){toast(e.message);}finally{button.disabled=false;}
}
async function groqFetch(path, init) {
  try {
    const response = await fetch(mode==='team'?`${TEAM_API_BASE}/${path}`:`https://api.groq.com/openai/v1/${path}`, {...init, headers:{...init.headers,Authorization:`Bearer ${mode==='team'?teamSession:apiKey}`},signal:AbortSignal.timeout(path==='audio/transcriptions'?90000:60000)});
    if (!response.ok) {
      if(mode==='team'&&response.status===401){teamSession='';try{sessionStorage.removeItem('demitask:team-session');}catch{}setMode('team');throw new Error('Сессия закончилась. Введите код команды в подключении.');}
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
  if (busy||recording||voicePending()) return;
  forceDraft=forceDraft||!$('#smart-toggle').checked;
  const input=$('#task-input').value.trim();
  if (!input) { error('Расскажите голосом или напишите, что нужно сделать.');$('#task-input').focus();return; }
  if (mode==='team'&&!teamSession){openPanel('settings');return;}
  if (mode==='live'&&!apiKey) { openPanel('settings');return; }
  if(voiceJobs.some(j=>j.status==='error')&&!partialAccepted){error('Не все фрагменты распознаны. Повторите их обработку или явно выберите распознанную часть в блоке записи.');return;}
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
      questions=data.questions;renderQuestions();persistDraft();stage(2);$('#result-status').textContent='УТОЧНЯЕМ ДЕТАЛИ';
      $('#questions-card').scrollIntoView({behavior:'smooth',block:'nearest'});
    } else {
      questions=[];result=data;$('#questions-card').hidden=true;renderResult();stage(3);saveHistory(input);toast(mode==='demo'?'Демочерновик готов':'Задача готова. Проверьте перед переносом.');
      if (window.innerWidth<951) $('#preview-example').closest('.preview-column').scrollIntoView({behavior:'smooth',block:'start'});
    }
  } catch(e) { error(e.message); } finally { setBusy(false); }
}
function renderQuestions() {
  $('#questions-fields').innerHTML=questions.map((q,i)=>`<div class="question"><label class="field-label" for="answer-${i}">${i+1}. ${esc(q.label)}</label><textarea id="answer-${i}" data-answer="${i}" placeholder="${esc(q.hint)}">${esc(answers[q.id] || '')}</textarea><button class="answer-voice-button" type="button" data-voice-target="answer-${i}" aria-label="Ответить голосом на вопрос ${i+1}">♩ Ответить голосом</button></div>`).join('');
  $('#questions-card').hidden=false;
}
function captureAnswers() { questions.forEach((q,i)=>{const field=$(`#answer-${i}`);if(field)answers[q.id]=field.value.trim();}); }
function qualityMarkup() {
  const q=result.quality||assessQuality(result);
  const label={green:'Понятная задача',yellow:'Есть что уточнить',red:'Может быть непонятно'}[q.level];
  return `<div class="quality-box ${q.level}"><button type="button" id="quality-button" class="quality-button" aria-expanded="false" aria-controls="quality-details" title="${esc(q.summary)} Нажмите, чтобы посмотреть пояснения."><span class="quality-dot"></span>${label}<span class="quality-help">?</span></button><div id="quality-details" popover="auto"><p>${esc(q.summary)}</p>${q.issues.length?`<ul>${q.issues.map((issue,i)=>`<li><button type="button" class="quality-issue" data-quality-issue="${i}"><strong>${esc(issue.detail)}</strong><span>${esc(issue.suggestion)}</span></button></li>`).join('')}</ul>`:''}<small>Оценка понятности помогает проверить постановку, но не заменяет вашу проверку.</small></div></div>`;
}
function highlightQuality(selected) {
  document.querySelectorAll('mark.quality-mark').forEach(mark=>mark.replaceWith(document.createTextNode(mark.textContent)));
  const issues=(result.quality||assessQuality(result)).issues;
  for(const [i,issue] of issues.entries()){
    if(selected!==undefined&&selected!==i)continue;
    const card=$(`[data-task-index="${issue.taskIndex}"]`);
    const field=card?.querySelector(`[data-quality-field="${issue.section}"]`)||card?.querySelector(['title','outcome'].includes(issue.section)?'.result-title':'.rich-description');
    if(!field)continue;
    const walker=document.createTreeWalker(field,NodeFilter.SHOW_TEXT);let text;
    while((text=walker.nextNode())){
      if(!text.textContent.trim()||text.parentElement.closest('mark,h4'))continue;
      const quote=typeof issue.quote==='string'?issue.quote.trim():'';
      const position=quote?text.textContent.toLocaleLowerCase('ru').indexOf(quote.toLocaleLowerCase('ru')):0;
      if(position<0)continue;
      const range=document.createRange();range.setStart(text,position);range.setEnd(text,position+(quote?quote.length:Math.min(text.textContent.length,100)));
      const mark=document.createElement('mark');mark.className='quality-mark '+(result.quality?.level||'yellow');mark.title=issue.detail+' '+issue.suggestion;range.surroundContents(mark);break;
    }
  }
}
function toggleQuality() {
  const panel=$('#quality-details');
  if(panel.matches(':popover-open')){panel.hidePopover();$('#quality-button').setAttribute('aria-expanded','false');}
  else{highlightQuality();panel.showPopover();positionQualityPopover();}
}
function positionQualityPopover() {
  const panel=$('#quality-details');
  if(!panel?.matches(':popover-open'))return;
  const button=$('#quality-button').getBoundingClientRect();
  const gap=12, margin=16;
  const left=Math.max(margin,Math.min(button.right-panel.offsetWidth,window.innerWidth-panel.offsetWidth-margin));
  const below=window.innerHeight-button.bottom-gap-margin;
  const above=button.top-gap-margin;
  const top=below>=Math.min(panel.offsetHeight,240)||below>=above?button.bottom+gap:Math.max(margin,button.top-panel.offsetHeight-gap);
  panel.style.left=`${left}px`;panel.style.top=`${Math.min(top,window.innerHeight-panel.offsetHeight-margin)}px`;
}
window.addEventListener('resize',positionQualityPopover);
document.addEventListener('scroll',positionQualityPopover,true);
function renderTask(task,index) {
  const editing=inlineEditIndex===index;
  const editAttributes=field=>`data-edit-field="${field}" ${editing?'contenteditable="'+(field==='description'?'true':'plaintext-only')+'" role="textbox"':'tabindex="0"'} ${editing?'aria-label="'+({title:'Название задачи',outcome:'ЦКП задачи',description:'Описание задачи',checklistTitle:'Название чек-листа',checklist:'Пункт чек-листа'})[field]+'"':''}`;
  return `<article class="card result-card ${editing?'is-editing':''}" data-task-index="${index}"><div class="card-heading"><span class="task-tag">${index===0?(result.subtasks.length?'МАТЕРИНСКАЯ ЗАДАЧА':'НАЗВАНИЕ ЗАДАЧИ'):`ПОДЗАДАЧА ${index}`}</span>${editing?'<span class="editing-label">Редактирование</span>':`<button class="text-button" data-inline-edit="${index}">Править ↗</button>`}</div>
    ${editing?`<div class="format-toolbar" role="toolbar" aria-label="Форматирование описания"><button type="button" data-format="bold" aria-label="Жирный" title="Жирный"><b>Ж</b></button><button type="button" data-format="italic" aria-label="Курсив" title="Курсив"><i>К</i></button><button type="button" data-format="underline" aria-label="Подчёркнутый" title="Подчёркнутый"><u>Ч</u></button><span></span><button type="button" data-format="insertUnorderedList" aria-label="Маркированный список" title="Маркированный список">• ≡</button><button type="button" data-format="insertOrderedList" aria-label="Нумерованный список" title="Нумерованный список">1. ≡</button><button type="button" data-format="removeFormat" aria-label="Убрать форматирование" title="Убрать форматирование">T×</button></div>`:''}
    <h3 class="result-title" data-quality-field="title"><span ${editAttributes('title')}>${esc(task.title)}</span>${task.outcome.trim()||editing?`<small data-quality-field="outcome">(ЦКП: <span ${editAttributes('outcome')}>${esc(task.outcome)}</span>)</small>`:''}</h3>
    <div class="copy-row"><button class="copy-button" data-copy="title" data-index="${index}">⧉ Название с ЦКП</button><button class="copy-button" data-copy="outcome" data-index="${index}">⧉ Только ЦКП</button></div>
    <div class="result-section"><div class="result-section-heading"><h3>Описание</h3><button class="copy-button" data-copy="description" data-index="${index}">⧉ С форматированием</button></div><div class="rich-description" ${editAttributes('description')}>${descriptionHTML(task)}</div></div>
    ${task.checklist.length||editing?`<div class="result-section"><div class="result-section-heading"><h3>Чек-лист</h3><button class="copy-button" data-copy="checklist" data-index="${index}">⧉ Все пункты</button></div><div class="checklist-title-row" data-quality-field="checklist"><div class="checklist-name" ${editAttributes('checklistTitle')}>${esc(task.checklistTitle)}</div><button class="copy-button" data-copy="checklistTitle" data-index="${index}" aria-label="Скопировать название чек-листа">⧉ Название</button></div><ul class="result-checklist">${task.checklist.map((item,i)=>`<li><span ${editAttributes('checklist')}>${esc(item)}</span>${editing?`<button class="item-copy" data-remove-check="${i}" aria-label="Удалить пункт ${i+1}">×</button>`:`<button class="item-copy" data-copy="item" data-index="${index}" data-item="${i}" aria-label="Скопировать пункт ${i+1}" title="Скопировать пункт">⧉</button>`}</li>`).join('')}</ul>${editing?'<button class="text-button" data-add-check>＋ Добавить пункт</button>':''}</div>`:''}
    ${editing?'<div class="inline-actions"><button class="primary-button" data-save-inline>Сохранить</button><button class="text-button" data-cancel-inline>Отменить</button></div>':''}
  </article>`;
}
function renderResult() {
  if (!result?.task) return;
  $('#empty-preview').hidden=true;$('#result-container').hidden=false;
  $('#result-status').textContent=result.warnings.some(w=>w.includes('Деморежим'))?'ДЕМОЧЕРНОВИК':'ГОТОВО К ПРОВЕРКЕ';$('#result-status').classList.add('ready');
  $('#result-container').innerHTML=qualityMarkup()+(result.warnings.length?`<div class="result-note">${result.warnings.map(esc).join('<br>')}</div>`:'')+renderTask(result.task,0)+(result.subtasks.length?`<div class="subtask-label">ПОДЗАДАЧИ · ${result.subtasks.length}</div>`:'')+result.subtasks.map((t,i)=>renderTask(t,i+1)).join('')+`<div class="result-actions"><button class="ai-revise-button" id="ai-revise">✧ Поправить с ИИ</button><button class="text-button" id="start-over">＋ Новая задача</button></div>`;
  $('#quality-details').addEventListener('toggle',e=>$('#quality-button').setAttribute('aria-expanded',String(e.newState==='open')));
}
function beginInlineEdit(index,field='description') {
  if(busy||recording||voicePending())return;
  if(inlineEditIndex===index)return;
  if(inlineEditIndex!==null&&!saveInlineEdit())return;
  inlineEditIndex=index;inlineOriginal=structuredClone(taskAt(index));renderResult();
  $(`[data-task-index="${index}"] [data-edit-field="${field}"]`)?.focus();
}
function readInlineTask() {
  const card=$(`[data-task-index="${inlineEditIndex}"]`);
  const read=field=>card.querySelector(`[data-edit-field="${field}"]`).innerText.trim();
  return {...taskAt(inlineEditIndex),title:read('title'),outcome:read('outcome'),descriptionRich:sanitizeRichHTML(card.querySelector('[data-edit-field="description"]').innerHTML),checklistTitle:read('checklistTitle'),checklist:[...card.querySelectorAll('[data-edit-field="checklist"]')].map(x=>x.innerText.trim()).filter(Boolean)};
}
function saveInlineEdit() {
  if(inlineEditIndex===null)return true;
  const next=readInlineTask();
  if(!next.title){toast('Добавьте название задачи.');return false;}
  if(next.checklist.length&&!next.checklistTitle){toast('Добавьте название чек-листа.');return false;}
  if(next.descriptionRich.length>80000){toast('Описание слишком длинное. Сократите его перед сохранением.');return false;}
  const before={...inlineOriginal,descriptionRich:sanitizeRichHTML(descriptionHTML(inlineOriginal))};
  if(JSON.stringify(before)!==JSON.stringify(next)){
    Object.assign(taskAt(inlineEditIndex),next);
    result.quality={level:'yellow',summary:'Задача изменена вручную. Проверьте понятность и полноту новых формулировок.',issues:[{taskIndex:inlineEditIndex,section:'context',quote:'',detail:'После ручных правок оценку нужно пересмотреть.',suggestion:'Проверьте результат самостоятельно или попросите ИИ проверить понятность.'}]};
    saveHistory($('#task-input').value.trim());
  }
  inlineEditIndex=null;inlineOriginal=null;renderResult();toast('Правки сохранены');return true;
}
function cancelInlineEdit() {inlineEditIndex=null;inlineOriginal=null;renderResult();}
function openAIRevision() {
  if(busy||!result?.task)return;
  if(!saveInlineEdit())return;
  if((mode==='team'&&!teamSession)||(mode==='live'&&!apiKey)){openPanel('settings');return;}
  if(mode==='demo'){toast('Для правок с ИИ нужен доступ команды.');openPanel('settings');return;}
  revisionDraft=null;$('#panel-title').textContent='Поправить с ИИ';
  $('#panel-body').innerHTML=`<p class="panel-intro">Опишите, что изменить. Остальное постараемся сохранить.</p><form id="revision-form"><div class="form-field"><label for="revision-instruction">Что поправить?</label><textarea id="revision-instruction" maxlength="6000" required placeholder="Например: сократи описание, добавь проверку мобильной версии и выдели важные требования жирным."></textarea></div><button class="primary-button">Предложить правки</button><p class="revision-note">Сначала покажем новую версию. Исходная задача изменится после вашего подтверждения.</p></form>`;
  $('#panel-dialog').classList.add('revision-dialog');$('#panel-dialog').showModal();$('#revision-instruction').focus();
}
async function reviseWithAI() {
  const instruction=$('#revision-instruction').value.trim();if(!instruction||revisionPending)return;
  revisionPending=true;setBusy(true);$('#close-panel').disabled=true;
  $('#revision-form').querySelectorAll('button,textarea').forEach(x=>x.disabled=true);
  $('#revision-form button').textContent='Готовим правки…';
  try{
    const response=await groqFetch('chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages:buildRevisionMessages({result,instruction,terms,rules}),response_format:{type:'json_schema',json_schema:{name:'task_revision',strict:true,schema:RESPONSE_SCHEMA}},max_completion_tokens:4000})});
    const choice=response.choices?.[0];if(choice?.finish_reason==='length')throw new Error('Ответ получился слишком длинным. Попросите изменить меньшую часть задачи.');
    let data;try{data=JSON.parse(choice?.message?.content||'');}catch{throw new Error('Не удалось прочитать правки. Исходная задача сохранена.');}
    revisionDraft=validateResponse(data,{subtasks:Boolean(data.subtasks?.length),checklist:true});
    if(!revisionDraft.task)throw new Error('ИИ не подготовил готовую версию. Уточните, что изменить.');
    $('#panel-body').innerHTML=`<p class="panel-intro">Предложенная версия. Проверьте её перед применением.</p>${[revisionDraft.task,...revisionDraft.subtasks].map((t,i)=>`<section class="revision-preview"><span class="task-tag">${i?'ПОДЗАДАЧА '+i:'ЗАДАЧА'}</span><h3>${esc(fullTitle(t))}</h3><div class="rich-description">${descriptionHTML(t)}</div>${t.checklist.length?`<h4>${esc(t.checklistTitle)}</h4><ul>${t.checklist.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}</section>`).join('')}<div class="panel-actions"><button class="primary-button" id="accept-revision">Применить правки</button><button class="text-button" id="reject-revision">Оставить исходную</button></div>`;
  }catch(e){toast(e.message);if($('#revision-form')){$('#revision-form').querySelectorAll('button,textarea').forEach(x=>x.disabled=false);$('#revision-form button').textContent='Предложить правки';}}
  finally{revisionPending=false;setBusy(false);$('#close-panel').disabled=false;}
}
$('#panel-dialog').addEventListener('cancel',e=>{if(revisionPending)e.preventDefault();});
$('#panel-dialog').addEventListener('close',()=>{$('#panel-dialog').classList.remove('revision-dialog');revisionDraft=null;});
$('#result-container').addEventListener('mousedown',e=>{if(e.target.closest('[data-format]'))e.preventDefault();});
$('#result-container').addEventListener('paste',e=>{
  const field=e.target.closest('[contenteditable="true"]');if(!field)return;
  e.preventDefault();const html=e.clipboardData.getData('text/html');
  const plain=e.clipboardData.getData('text/plain');
  if(window.getSelection()?.toString().trim()===field.innerText.trim()){
    field.innerHTML=html?sanitizeRichHTML(html):esc(plain).replaceAll('\n','<br>');
    const range=document.createRange();range.selectNodeContents(field);range.collapse(false);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  }else document.execCommand(html?'insertHTML':'insertText',false,html?sanitizeRichHTML(html):plain);
});
$('#result-container').addEventListener('drop',e=>{if(e.target.closest('[contenteditable]')){e.preventDefault();document.execCommand('insertText',false,e.dataTransfer.getData('text/plain'));}});
$('#result-container').addEventListener('keydown',e=>{
  const field=e.target.closest('[data-edit-field]');if(!field)return;
  if(inlineEditIndex===null&&(e.key==='Enter'||e.key===' ')){e.preventDefault();beginInlineEdit(Number(field.closest('[data-task-index]').dataset.taskIndex),field.dataset.editField);return;}
  if(inlineEditIndex!==null&&e.key==='Escape'){e.preventDefault();cancelInlineEdit();}
  if(inlineEditIndex!==null&&(e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();saveInlineEdit();}
  if(inlineEditIndex!==null&&e.key==='Enter'&&['title','outcome','checklistTitle'].includes(field.dataset.editField))e.preventDefault();
});

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
function newTask() { if (busy||recording||voicePending()) return;$('#task-input').value='';invalidate();$('#task-input').focus();window.scrollTo({top:0,behavior:'smooth'}); }

function openPanel(name) {
  if(inlineEditIndex!==null&&!saveInlineEdit())return;
  const panel=$('#panel-body');
  const titles={dictionary:'Ваш словарь',rules:'Как ставим задачи',history:'История задач',settings:'Подключение нейросети',help:'Как работает ДемиТаск'};
  $('#panel-title').textContent=titles[name]||'Редактировать задачу';
  if (name==='help') {
    panel.innerHTML=`<p class="help-lead">Из мысли — в задачу, которую легко выполнить.</p><div class="help-grid"><section class="help-card"><span class="help-number">01</span><h3>Расскажите идею</h3><p>Напишите или нажмите микрофон. Добавьте контекст и желаемый результат.</p></section><section class="help-card"><span class="help-number">02</span><h3>Уточните, если нужно</h3><p>«Умная постановка» задаёт вопросы. На них тоже можно ответить голосом. Без галочки задача сразу собирается по известным данным.</p></section><section class="help-card"><span class="help-number">03</span><h3>Проверьте понятность</h3><p>Нажмите на индикатор: пояснения откроются поверх страницы, а замечания выделят фразы в тексте.</p><div class="help-quality"><span class="green">Ясно</span><span class="yellow">Есть пробелы</span><span class="red">Непонятно</span></div></section><section class="help-card"><span class="help-number">04</span><h3>Доведите до готовности</h3><p>Нажмите на текст для правки и форматирования. «Поправить с ИИ» предложит изменения, которые можно принять или отменить.</p></section><section class="help-card"><span class="help-number">05</span><h3>Скопируйте в Битрикс24</h3><p>Название с ЦКП, описание с форматированием и каждый пункт чек-листа копируются отдельно. Подзадачи включаются перед сборкой.</p></section><section class="help-card"><span class="help-number">06</span><h3>Настройте под команду</h3><p>В словаре — модели и произношение, в регламенте — правила постановки, в истории — последние 12 задач. Сроки и исполнителя не запрашиваем.</p></section></div><details class="help-data"><summary>О голосе и сохранении данных</summary><p>Распознавание выбирается автоматически: сначала сервис браузера, при недоступности — резервное через общий доступ команды. Браузерное распознавание не расходует квоту Groq; резервное работает в пределах его бесплатной аудиоквоты. Оба способа могут передавать речь внешнему сервису.</p><p>После записи дождитесь завершения обработки. Если фрагмент не распознан, его можно прослушать и обработать снова. Звук остаётся в памяти вкладки до перезагрузки.</p><p>Черновик, словарь, регламент и история сохраняются в этом браузере. Текст и словарь при работе с ИИ передаются через сервер команды в Groq. Код команды вводится в «Подключение AI»; личный API-ключ не нужен. Оценка понятности помогает проверке и не заменяет вашу оценку результата.</p></details>`;
  } else if (name==='dictionary') {
    panel.innerHTML=`<p class="panel-intro">Правильные названия моделей, характеристики и рабочие термины. Словарь помогает распознавать речь и сохранять нужные формулировки.</p><form id="term-form"><div class="form-field"><label for="term-name">Правильное название</label><input id="term-name" required maxlength="80" placeholder="Например, HARRINGTON DK-5100"></div><div class="form-field"><label for="term-aliases">Как это может звучать или распознаваться</label><input id="term-aliases" maxlength="250" placeholder="харрингтон, харингтон, пять тысяч сто"></div><div class="form-field"><label for="term-note">Пояснение или характеристики</label><textarea id="term-note" maxlength="600" placeholder="Что важно знать об этой модели"></textarea></div><button class="primary-button">＋ Добавить в словарь</button></form><div class="dictionary-list">${terms.map(t=>`<div class="term-card"><div class="term-top"><strong>${esc(t.term)}</strong><button class="delete-button" data-delete-term="${esc(t.id)}">Удалить</button></div><p>${esc(t.aliases)}</p><p>${esc(t.note)}</p></div>`).join('')||'<p class="muted">Пока пусто. Добавьте первый термин.</p>'}</div><p class="muted">До 120 записей. Падежные формы русских названий учитываются; спорные варианты можно добавить через запятую. Словарь хранится в этом браузере и передаётся Groq при обработке. Характеристики используются как контекст, а не добавляются во все задачи автоматически.</p>`;
  } else if (name==='rules') {
    panel.innerHTML=`<p class="panel-intro">Это ваш регламент. Нейросеть получает его при каждом запросе. В деморежиме используется фиксированный шаблон.</p><form id="rules-form"><div class="form-field"><label for="rules-text">Правила постановки</label><textarea id="rules-text" class="rules-text" maxlength="12000" required>${esc(rules)}</textarea></div><div class="panel-actions"><button class="primary-button">Сохранить регламент</button><button type="button" class="text-button" id="reset-rules">Базовый вариант</button></div></form>`;
  } else if (name==='history') {
    panel.innerHTML=`<p class="panel-intro">Последние 12 собранных задач. Хранятся только в этом браузере. Исходные мысли и результаты не публикуются на GitHub.</p>${history.map(h=>`<button class="history-item" data-history="${esc(h.id)}"><strong>${esc(h.result.task.title)}</strong><small>${esc(new Date(h.date).toLocaleString('ru-RU',{dateStyle:'medium',timeStyle:'short'}))} · ${h.result.subtasks?.length||0} подзадач</small></button>`).join('')||'<div class="panel-box">Соберите первую задачу — она появится здесь.</div>'}${history.length?'<button class="text-button" id="clear-history">Очистить историю в этом браузере</button>':''}`;
  } else if (name==='settings') {
    if(TEAM_API_BASE){
      panel.innerHTML=`<p class="panel-intro">Общий доступ команды DEMIAND. Личный API-ключ не нужен.</p><form id="team-form"><div class="form-field"><label for="team-code">Код команды</label><input id="team-code" type="password" autocomplete="off" required placeholder="Получите код у владельца"><small>Сессия действует 12 часов в этой вкладке. Код открывает доступ к общей квоте, но не раскрывает API-ключ.</small></div><button class="primary-button">Войти в команду</button><p class="muted">Исходный текст, ответы и словарь передаются через сервер команды в Groq. Распознавание браузером бесплатно и работает отдельно.</p></form>`;if(!$('#panel-dialog').open)$('#panel-dialog').showModal();return;
    }
    panel.innerHTML=`<p class="panel-intro">Для прототипа подойдёт бесплатный тариф Groq: одна учётная запись для составления задач и распознавания речи.</p><div class="panel-box">1. Откройте <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">Groq → API Keys ↗</a><br>2. Создайте ключ и вставьте его ниже.<br>3. Выберите «Подключить Groq».<br><a href="https://console.groq.com/docs/rate-limits" target="_blank" rel="noopener noreferrer">Бесплатные квоты и текущие ограничения ↗</a></div><form id="settings-form"><div class="form-field"><label for="api-key">Ваш API-ключ Groq</label><input id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="${apiKey?'Ключ уже введён; пусто — оставить текущий':'gsk_…'}"><small>Ключ живёт только в памяти этой вкладки и отправляется напрямую api.groq.com. После перезагрузки его нужно ввести снова. В код, историю и хранилище браузера он не записывается.</small></div><div class="form-field"><label for="model-select">Модель для задач</label><select id="model-select"><option value="openai/gpt-oss-120b">GPT OSS 120B · основной вариант</option><option value="openai/gpt-oss-20b">GPT OSS 20B · компактнее</option><option value="qwen/qwen3.8-27b">Qwen 3.8 27B · альтернатива</option></select></div><div class="panel-actions"><button class="primary-button">Подключить Groq</button><button type="button" class="text-button" id="demo-mode">Деморежим</button></div><p class="muted">Подключение проверяется при первом запросе. В режиме Groq исходная мысль, ответы, регламент, словарь и записанное аудио передаются провайдеру. Квоты и доступность зависят от аккаунта и региона. Для общего сервиса с одним ключом понадобится серверный прокси с авторизацией.</p><p class="muted">Без ключа голосовой ввод доступен через распознавание браузера, если оно поддерживается; речь может обрабатываться сервисом браузера. С ключом запись распознаёт Whisper, словарь передаётся как подсказка.</p></form>`;
    $('#model-select').value=model;
  }
  if (!$('#panel-dialog').open) $('#panel-dialog').showModal();
}
function voicePending() { return voiceFinishing||voiceProcessing||voiceJobs.some(j=>j.status==='waiting'||j.status==='processing'); }
function voiceTargetButton() { return voiceTarget==='task-input'?$('#voice-button'):$(`[data-voice-target="${voiceTarget}"]`); }
function voicePanel() { return $('#voice-panel'); }
function voiceSeconds() {const n=Math.floor((Date.now()-voiceStartedAt)/1000);return `${Math.floor(n/60).toString().padStart(2,'0')}:${(n%60).toString().padStart(2,'0')}`;}
function updateVoiceUI() {
  const locked=recording||voicePending();
  const activeButton=voiceTargetButton();
  ['#generate-button','#task-input','#smart-toggle','#subtasks-toggle','#checklist-toggle','#example-button','#preview-example','#new-task'].forEach(s=>$(s).disabled=busy||locked);
  $('#questions-form').querySelectorAll('button,textarea').forEach(x=>x.disabled=busy||locked);
  document.querySelectorAll('[data-voice-target],#voice-button').forEach(b=>{b.disabled=busy||locked;b.classList.remove('recording');});
  if(recording&&activeButton){activeButton.disabled=false;activeButton.classList.add('recording');}
  $('#voice-label').textContent=recording&&voiceTarget==='task-input'?'Остановить запись':'Просто расскажите голосом';
  $('#voice-hint').textContent=recording&&voiceTarget==='task-input'?`Запись ${voiceSeconds()} · текст появится по частям`:'Нажмите, чтобы начать запись';
  document.querySelectorAll('[data-voice-target]').forEach(b=>b.textContent=recording&&b.dataset.voiceTarget===voiceTarget?'■ Закончить ответ':'♩ Ответить голосом');
  if(!voiceStartedAt)return;
  const done=voiceJobs.filter(j=>j.status==='done').length,failed=voiceJobs.filter(j=>j.status==='error').length;
  $('#voice-progress').textContent=recording?`Запись ${voiceSeconds()}${voiceJobs.length?` · распознано ${done} из ${voiceJobs.length} фрагментов`:''}`:voicePending()?`Распознаём: ${done} из ${voiceJobs.length} фрагментов` :failed?`Не распознано фрагментов: ${failed}. Запись сохранена ниже.`:voiceJobs.length?`Готово: распознаны все ${done} фрагм. за ${voiceSeconds()}`:'Голосовой ввод завершён';
  $('#voice-recovery-list').innerHTML=voiceJobs.map(j=>`<div class="audio-fragment"><div><strong>Фрагмент ${j.index+1}</strong><span>${j.status==='done'?'✓ Распознан':j.status==='error'?'Не распознан':j.status==='processing'?'Распознаём…':'В очереди'}</span></div><audio controls preload="none" src="${j.url}" aria-label="Прослушать фрагмент ${j.index+1}"></audio><div><a href="${j.url}" download="demitask-voice-${j.index+1}.${j.blob.type.includes('mp4')?'mp4':j.blob.type.includes('ogg')?'ogg':'webm'}">Скачать звук</a>${j.status==='error'?`<button type="button" class="text-button" data-retry-voice="${j.index}">Повторить распознавание</button><p class="muted">${esc(j.error)}</p>`:''}</div></div>`).join('');
  $('#voice-recovery').hidden=!voiceJobs.length;
  $('#accept-partial').hidden=!failed||locked||partialAccepted;
  voicePanel().hidden=false;
}
function writeVoiceText() {
  const target=document.getElementById(voiceTarget);if(!target)return;
  const spoken=voiceEngine==='groq'?joinSegments(voiceJobs):mergeTranscript(browserCommitted,browserSpoken,false);
  target.value=[voiceBase,normalizeTerms(spoken,terms)].filter(x=>x.trim()).join('\n');
  if(voiceTarget==='task-input'){invalidate();}else{captureAnswers();persistDraft();}
}
async function transcribeQueue() {
  if(voiceProcessing)return;voiceProcessing=true;
  try {
    while(voiceJobs.some(j=>j.status==='waiting')){
      const job=voiceJobs.find(j=>j.status==='waiting');job.status='processing';updateVoiceUI();
      try{
        if(job.blob.size>25*1024*1024)throw new Error('Фрагмент превышает 25 МБ. Скачайте исходный звук и разделите файл.');
        const form=new FormData();form.append('file',job.blob,`voice.${job.blob.type.includes('mp4')?'mp4':job.blob.type.includes('ogg')?'ogg':'webm'}`);form.append('model','whisper-large-v3-turbo');form.append('language','ru');form.append('response_format','json');
        form.append('prompt',speechGlossary(terms,$('#task-input').value));
        const data=await groqFetch('audio/transcriptions',{method:'POST',body:form});
        if(!data.text?.trim())throw new Error('Речь в этом фрагменте не распознана. Прослушайте запись или повторите обработку.');
        job.text=data.text;job.status='done';writeVoiceText();
      }catch(e){job.status='error';job.error=e.message;}
      updateVoiceUI();
    }
  }finally{voiceProcessing=false;updateVoiceUI();}
}
function stopStream() {clearInterval(recordTimer);mediaStream?.getTracks().forEach(t=>t.stop());mediaStream=null;}
async function finishVoice() {
  recording=false;voiceFinishing=true;clearInterval(recordTimer);updateVoiceUI();
  if(capture){await capture.stop();capture=null;stopStream();}
  else if(recognition)await new Promise(resolve=>{browserEndResolve=resolve;try{recognition.stop();}catch{browserEndResolve=null;resolve();}});
  voiceFinishing=false;updateVoiceUI();
}
function startBrowserVoice(Speech) {
  const listen=()=>{
    recognition=new Speech();recognition.lang='ru-RU';recognition.continuous=true;recognition.interimResults=true;
    browserSpoken='';let useBackup=false;
    recognition.onresult=e=>{browserSpoken=collectSpeechResults(e.results);writeVoiceText();};
    recognition.onerror=e=>{
      if(e.error==='no-speech')return;
      recording=false;clearInterval(recordTimer);useBackup=['network','service-not-allowed','language-not-supported'].includes(e.error);
      if(useBackup)browserUnavailable=true;else error(e.error==='not-allowed'?'Разрешите доступ к микрофону.':'Распознавание прервалось. Текст сохранён. Нажмите запись ещё раз.');
    };
    recognition.onend=()=>{
      browserCommitted=mergeTranscript(browserCommitted,browserSpoken,false);browserSpoken='';writeVoiceText();
      browserEndResolve?.();browserEndResolve=null;
      if(useBackup){recognition=null;updateVoiceUI();toast('Включаем резервное распознавание. Повторите последнюю фразу.');startVoice(voiceTarget,true);return;}
      if(recording){try{listen();}catch{recording=false;clearInterval(recordTimer);error('Браузер остановил микрофон. Текст сохранён. Нажмите запись ещё раз.');}}
      updateVoiceUI();
    };
    recognition.start();
  };
  listen();
}
async function startVoice(targetId='task-input',forceBackup=false) {
  if(busy)return;
  if(recording){if(voiceTarget===targetId)await finishVoice();return;}
  if(voicePending())return;
  if(voiceJobs.some(j=>j.status==='error')&&!partialAccepted){error('Сначала повторите обработку пропущенных фрагментов или выберите «Использовать распознанную часть».');return;}
  const target=document.getElementById(targetId);if(!target)return;
  error();voiceTarget=targetId;voiceBase=target.value.trim();voiceJobs.forEach(j=>URL.revokeObjectURL(j.url));voiceJobs=[];partialAccepted=false;
  browserSpoken='';browserCommitted='';voiceStartedAt=Date.now();
  voiceEngine=forceBackup||browserUnavailable||!(window.SpeechRecognition||window.webkitSpeechRecognition)?'groq':'browser';
  if(voiceEngine==='groq'){
    if(!((mode==='live'&&apiKey)||(mode==='team'&&teamSession))){error('Для голосового ввода в этом браузере войдите по коду команды.');openPanel('settings');return;}
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){error('Этот браузер не поддерживает запись. Откройте современный Chrome, Edge или Safari.');return;}
    recording=true;updateVoiceUI();voiceTargetButton().disabled=true;
    try{
      mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
      const mimeType=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
      capture=new SegmentedCapture({stream:mediaStream,Recorder:MediaRecorder,mimeType,onSegment:segment=>{
        const job={...segment,url:URL.createObjectURL(segment.blob),status:'waiting',text:'',error:''};voiceJobs.push(job);voiceJobs.sort((a,b)=>a.index-b.index);updateVoiceUI();transcribeQueue();
      },onError:()=>{error('Микрофон прервал запись. Доступные фрагменты сохранены для повторной обработки.');finishVoice();}});
      capture.start();mediaStream.getAudioTracks().forEach(t=>t.addEventListener('ended',()=>{if(recording){error('Микрофон отключён. Сохранённые фрагменты будут распознаны.');finishVoice();}},{once:true}));
      recordTimer=setInterval(updateVoiceUI,1000);updateVoiceUI();
    }catch(e){recording=false;stopStream();updateVoiceUI();error(e.name==='NotAllowedError'?'Нет доступа к микрофону. Разрешите его для этой страницы в браузере.':e.name==='NotFoundError'?'Микрофон не найден.':'Не удалось начать запись. Проверьте микрофон и повторите.');}
  }else{
    const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
    try{recording=true;startBrowserVoice(Speech);recordTimer=setInterval(updateVoiceUI,1000);updateVoiceUI();}catch{recording=false;browserUnavailable=true;await startVoice(targetId,true);}
  }
}

$('#task-input').addEventListener('input',invalidate);
$('#subtasks-toggle').addEventListener('change',invalidate);
$('#checklist-toggle').addEventListener('change',invalidate);
$('#smart-toggle').addEventListener('change',invalidate);
$('#example-button').addEventListener('click',inputExample);
$('#preview-example').addEventListener('click',inputExample);
$('#generate-button').addEventListener('click',()=>generate());
$('#voice-button').addEventListener('click',()=>startVoice('task-input'));
$('#new-task').addEventListener('click',newTask);
$('#studio-nav').addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'}));
$('#questions-fields').addEventListener('input',()=>{captureAnswers();persistDraft();});
$('#questions-form').addEventListener('submit',e=>{e.preventDefault();captureAnswers();generate(true);});
$('#skip-questions').addEventListener('click',()=>{captureAnswers();generate(true);});
$('#close-panel').addEventListener('click',()=>{if(!revisionPending)$('#panel-dialog').close();});
$('#panel-dialog').addEventListener('click',e=>{if(!revisionPending&&e.target===$('#panel-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
document.addEventListener('click',async e=>{
  const button=e.target.closest('button');
  if(!button){const field=e.target.closest('[data-edit-field]');if(field&&inlineEditIndex===null)beginInlineEdit(Number(field.closest('[data-task-index]').dataset.taskIndex),field.dataset.editField);return;}
  if(button.dataset.inlineEdit!==undefined){beginInlineEdit(Number(button.dataset.inlineEdit));return;}
  if(button.hasAttribute('data-save-inline')){saveInlineEdit();return;}
  if(button.hasAttribute('data-cancel-inline')){cancelInlineEdit();return;}
  if(button.hasAttribute('data-add-check')){const list=$(`[data-task-index="${inlineEditIndex}"] .result-checklist`);const item=document.createElement('li');item.innerHTML='<span data-edit-field="checklist" contenteditable="plaintext-only" role="textbox" aria-label="Пункт чек-листа"></span><button class="item-copy" data-remove-check aria-label="Удалить пункт">×</button>';list.append(item);item.querySelector('span').focus();return;}
  if(button.hasAttribute('data-remove-check')){button.closest('li').remove();return;}
  if(button.dataset.format){const editor=$(`[data-task-index="${inlineEditIndex}"] [data-edit-field="description"]`);const selection=window.getSelection();if(!selection?.anchorNode||!editor.contains(selection.anchorNode))editor.focus();document.execCommand(button.dataset.format,false,null);return;}
  if(button.id==='ai-revise'){openAIRevision();return;}
  if(button.id==='accept-revision'&&revisionDraft){result=revisionDraft;revisionDraft=null;$('#panel-dialog').close();renderResult();saveHistory($('#task-input').value.trim());toast('Правки ИИ применены');return;}
  if(button.id==='reject-revision'){$('#panel-dialog').close();toast('Исходная задача сохранена');return;}

  if(button.id==='quality-button'){toggleQuality();return;}
  if(button.dataset.qualityIssue!==undefined){highlightQuality(Number(button.dataset.qualityIssue));$('#quality-details').hidePopover();$('#quality-button').setAttribute('aria-expanded','false');return;}
  if(button.dataset.voiceTarget){startVoice(button.dataset.voiceTarget);return;}
  if(button.dataset.retryVoice!==undefined){const job=voiceJobs.find(j=>j.index===Number(button.dataset.retryVoice));if(job&&!voicePending()){job.status='waiting';partialAccepted=false;transcribeQueue();}return;}
  if(button.id==='accept-partial'){partialAccepted=true;toast('Выбрана распознанная часть. Проверьте пропуски по записи.');updateVoiceUI();return;}
  if(button.dataset.panel){openPanel(button.dataset.panel);return;}
  if(button.dataset.copy&&result){const t=inlineEditIndex===Number(button.dataset.index)?readInlineTask():taskAt(Number(button.dataset.index));const kind=button.dataset.copy;const values={title:fullTitle(t),outcome:`ЦКП: ${t.outcome}`,description:descriptionText(t),checklist:t.checklist.join('\n'),checklistTitle:t.checklistTitle,item:t.checklist[Number(button.dataset.item)]};await copy(values[kind],kind==='description'?descriptionHTML(t):null);return;}
  if(button.id==='start-over')newTask();
  if(button.dataset.deleteTerm){storage.write('removed-terms',[...new Set([...storage.read('removed-terms',[]),button.dataset.deleteTerm])]);terms=terms.filter(t=>t.id!==button.dataset.deleteTerm);storage.write('terms',terms);counters();openPanel('dictionary');}
  if(button.id==='reset-rules')$('#rules-text').value=DEFAULT_RULES;
  if(button.id==='demo-mode'){if(busy||recording||voicePending()){toast('Сначала завершите текущую операцию.');return;}apiKey='';setMode('demo');$('#panel-dialog').close();toast('Деморежим включён. Ключ удалён из памяти.');}
  if(button.id==='clear-history'){history=[];storage.write('history',history);counters();openPanel('history');}
  if(button.dataset.history){
    if(busy||recording||voicePending()){toast('Сначала завершите текущую обработку.');return;}
    const item=history.find(x=>x.id===button.dataset.history);if(!item)return;
    try{const restored=validateResponse(item.result,item.options||{});$('#task-input').value=item.input;$('#subtasks-toggle').checked=Boolean(item.options?.subtasks);$('#checklist-toggle').checked=item.options?.checklist!==false;$('#smart-toggle').checked=item.options?.smart!==false;invalidate();result=restored;answers=item.answers||{};renderResult();stage(3);$('#panel-dialog').close();persistDraft();}catch{toast('Эту запись не удалось восстановить.');}
  }
});
$('#panel-body').addEventListener('submit',e=>{
  e.preventDefault();
  if(e.target.id==='revision-form'){reviseWithAI();return;}
  if(e.target.id==='term-form'){
    if(terms.length>=120){toast('В словаре уже 120 записей. Удалите ненужные.');return;}
    const term=$('#term-name').value.trim();if(!term)return;
    if(terms.some(t=>t.term.toLowerCase()===term.toLowerCase())){toast('Такой термин уже есть. Удалите старую запись для замены.');return;}
    terms.push({id:crypto.randomUUID(),term,inflect:true,aliases:$('#term-aliases').value.trim(),note:$('#term-note').value.trim()});storage.write('terms',terms);counters();openPanel('dictionary');toast('Термин добавлен');
  }
  if(e.target.id==='rules-form'){rules=$('#rules-text').value.trim();if(!rules)return;storage.write('rules',rules);$('#panel-dialog').close();toast('Регламент сохранён');}
  if(e.target.id==='team-form'){connectTeam();return;}
  if(e.target.id==='settings-form'){
    if(recording||busy||voicePending()){toast('Дождитесь завершения текущей операции.');return;}
    const key=$('#api-key').value.trim();if(key)apiKey=key;
    if(!apiKey){toast('Введите API-ключ Groq или выберите деморежим.');return;}
    model=$('#model-select').value;setMode('live');$('#api-key').value='';$('#panel-dialog').close();toast('Groq выбран. Ключ проверится при первом запросе.');
  }

});
window.addEventListener('pagehide',()=>{recording=false;recognition?.abort();capture?.abort();stopStream();apiKey='';});
window.addEventListener('beforeunload',e=>{if(recording||voicePending()){e.preventDefault();e.returnValue='';}});
if(Array.isArray(draft.questions)&&draft.questions.length<=3&&draft.questions.every(q=>q&&['id','label','hint'].every(k=>typeof q[k]==='string'))){questions=draft.questions;answers=draft.answers&&typeof draft.answers==='object'?draft.answers:{};if(questions.length)renderQuestions();}
persistDraft();counters();setMode(mode);
