import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_TERMS,normalizeTerms,migrateTerms,GLOSSARY_VERSION} from '../glossary.js';
test('migration removes the retired demo and preserves custom terms and deleted defaults',()=>{
  const custom={id:'custom',term:'Личный термин',aliases:'личный',note:'Моё пояснение'};
  const list=migrateTerms([{id:'luna',term:'Luna',aliases:'луна',note:''},custom],0,['wifi']);
  assert.ok(!list.some(t=>t.id==='luna'));assert.deepEqual(list.find(t=>t.id==='custom'),custom);
  assert.ok(list.some(t=>t.term==='HARRINGTON DK-5100'));assert.ok(!list.some(t=>t.id==='wifi'));
  assert.deepEqual(migrateTerms([custom],GLOSSARY_VERSION),[custom]);
});
test('Russian inflections and longest names resolve without recursive substitutions',()=>{
  const text=normalizeTerms('Для сандерса макс и харрингтона, с демиандом и леокриспом.',DEFAULT_TERMS);
  assert.equal(text,'Для SANDERS MAX DK-2400 и HARRINGTON DK-5100, с DEMIAND и LEOCRISP DK-2500.');
});
test('marketplace aliases preserve rich-content case endings',()=>{
  assert.equal(normalizeTerms('На озоне и яндекс маркете: rich-контент, для рич-контента, с рич контентом. Эм пэ, mp, вэ бэ, вайлд бериз.',DEFAULT_TERMS),'На Ozon и Я.Маркете: рич-контент, для рич-контента, с рич-контентом. МП, МП, WB, WB.');
});
test('model codes are contextual and cannot corrupt prices or already normalized names',()=>{
  assert.equal(normalizeTerms('Бюджет 5100 рублей. Для модели 5100. HARRINGTON DK-5100.',DEFAULT_TERMS),'Бюджет 5100 рублей. Для модели HARRINGTON DK-5100. HARRINGTON DK-5100.');
});
