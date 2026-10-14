import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeRichHTML,richText} from '../rich-text.js';
import {descriptionHTML,descriptionText,validateResponse,buildRevisionMessages,demoResponse,EXAMPLE_INPUT,DEFAULT_RULES,DEFAULT_TERMS} from '../core.js';
test('rich text keeps formatting and removes executable markup and attributes',()=>{
  const html=sanitizeRichHTML('<p onclick="alert(1)">Текст <strong style="color:red">важно</strong><u>проверить</u></p><img src=x onerror=alert(1)><script>alert(1)</script><a href="javascript:alert(1)">ссылка</a>');
  assert.equal(html,'<p>Текст <strong>важно</strong><u>проверить</u></p>ссылка');
  assert.doesNotMatch(sanitizeRichHTML('<svg><foreignObject><iframe srcdoc="x"></iframe></foreignObject></svg><p title="<img src=x>">Безопасно</p>'),/<(?:svg|iframe|img)|onerror|srcdoc/);
});
test('manual rich descriptions survive validation, history and formatted copy',()=>{
  const result=demoResponse({input:EXAMPLE_INPUT,answers:{},forceDraft:true,checklist:true,subtasks:false});
  result.task.descriptionRich='<p>Обновить <strong>баннер</strong> &amp; <u>мобильную версию</u>.</p><ul><li>Проверить</li></ul>';
  const restored=validateResponse(JSON.parse(JSON.stringify(result)),{checklist:true});
  assert.match(descriptionHTML(restored.task),/<strong>баннер<\/strong>/);
  assert.match(descriptionText(restored.task),/Обновить баннер & мобильную версию/);
  assert.match(richText(restored.task.descriptionRich),/• Проверить/);
});
test('AI revision receives the current manual version and a separate revision request',()=>{
  const result=demoResponse({input:EXAMPLE_INPUT,answers:{},forceDraft:true,checklist:true,subtasks:false});result.task.descriptionRich='<p>Ручная правка</p>';
  const messages=buildRevisionMessages({result,instruction:'Сократи описание',terms:DEFAULT_TERMS,rules:DEFAULT_RULES});
  const request=JSON.parse(messages[1].content);assert.equal(request.current.task.descriptionRich,'<p>Ручная правка</p>');assert.equal(request.instruction,'Сократи описание');assert.match(messages[0].content,/Сохрани все факты/);
});
