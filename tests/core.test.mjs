import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLE_INPUT, DEFAULT_RULES, DEFAULT_TERMS, fullTitle, descriptionHTML, descriptionText, normalizeTerms, demoResponse, validateResponse, buildMessages } from '../core.js';

const request = {input:EXAMPLE_INPUT,terms:DEFAULT_TERMS,rules:DEFAULT_RULES,answers:{},subtasks:false,checklist:true};
const ready = overrides => demoResponse({...request,forceDraft:true,...overrides});
test('smart demo asks concrete questions without deadlines or assignees',()=>{
  const data=demoResponse(request);
  assert.equal(data.task,null);assert.equal(data.questions.length,3);
  assert.doesNotMatch(JSON.stringify(data.questions),/срок|исполнител/iu);
});
test('standard mode makes a draft and exposes missing information',()=>{
  const data=ready();assert.equal(data.questions.length,0);
  assert.match(fullTitle(data.task),/^Подготовить.+\(ЦКП: .+\)$/u);
  assert.match(data.task.requirements.join(' '),/требует уточнения/u);
  assert.ok(data.warnings.length);
});
test('answers are retained without invented dimensions',()=>{
  const data=ready({answers:{formats:'1920 × 640',materials:'Папка клиента',approval:'В PDF'}});
  assert.match(data.task.requirements.join(' '),/1920 × 640/u);
  assert.doesNotMatch(data.task.requirements.join(' '),/1440/u);
});
test('subtasks have their own outcomes and checklists can be disabled everywhere',()=>{
  const data=ready({subtasks:true,checklist:false});assert.equal(data.subtasks.length,3);
  for(const task of [data.task,...data.subtasks]){assert.ok(task.outcome);assert.deepEqual(task.checklist,[]);assert.equal(task.checklistTitle,'');}
});
test('glossary replaces complete Russian and Latin aliases, preserves longer words',()=>{
  const terms=[{term:'Luna S',aliases:'луна эс, luna c',note:''},{term:'X+1',aliases:'икс плюс, a.b',note:''}];
  assert.equal(normalizeTerms('ЛУНА ЭС, luna c; лунатик: a.b / aXb. Икс плюс.',terms),'Luna S, Luna S; лунатик: X+1 / aXb. X+1.');
});
test('HTML clipboard content escapes user input and omits checklist',()=>{
  const task=ready().task;task.context='<img src=x onerror=alert(1)>';task.steps=['<script>bad()</script>'];
  const html=descriptionHTML(task);assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<ol>'));assert.ok(html.includes('<ul>'));assert.ok(!html.includes(task.checklistTitle));
  assert.ok(descriptionText(task).includes(task.context));
});
test('malformed results and missing requested subtasks are rejected',()=>{
  assert.throws(()=>validateResponse({questions:[],task:{title:'x'},subtasks:[],warnings:[]}));
  assert.throws(()=>validateResponse(ready(),{subtasks:true,checklist:true}));
  assert.throws(()=>validateResponse({...ready(),questions:[{id:'x',label:'',hint:''}]}));
});
test('prompt transmits selected rules, vocabulary, answers and draft mode',()=>{
  const messages=buildMessages({...request,answers:{formats:'500 × 700'},forceDraft:true});
  const payload=JSON.parse(messages[1].content);
  assert.equal(payload.forceDraft,true);assert.equal(payload.answers.formats,'500 × 700');
  assert.equal(payload.glossary[0].term,'Luna');assert.ok(messages[0].content.includes(DEFAULT_RULES));
});
test('arbitrary demo never passes itself off as AI interpretation',()=>{
  const data=ready({input:'Собрать каталог деталей'});
  assert.equal(data.task.context,'Собрать каталог деталей');assert.match(data.warnings[0],/без нейросети/u);
  assert.doesNotMatch(data.task.context,/Luna/u);
});
