import test from 'node:test';
import assert from 'node:assert/strict';
import {SegmentedCapture,mergeTranscript,collectSpeechResults,joinSegments} from '../voice.js';
test('long transcript is preserved beyond the former 14000-character limit',()=>{
  const parts=Array.from({length:8},(_,index)=>({index,status:'done',overlap:false,text:`Начало ${index}. `+'Сохранить все произнесённые слова. '.repeat(120)+` Конец ${index}.`}));
  const joined=joinSegments(parts.reverse());assert.ok(joined.length>30000);
  assert.ok(joined.startsWith('Начало 0.'));assert.ok(joined.endsWith('Конец 7.'));
  for(let i=0;i<8;i++)assert.ok(joined.includes(`Конец ${i}.`));
});
test('segment overlap is deduplicated while intentional repeats without overlap survive',()=>{
  assert.equal(mergeTranscript('Нужно сделать большой баннер.','большой баннер и проверить размеры.',true),'Нужно сделать большой баннер и проверить размеры.');
  assert.equal(mergeTranscript('Проверить размеры','Проверить размеры',false),'Проверить размеры\nПроверить размеры');
});
test('interim tail is retained on browser stop',()=>{
  assert.equal(collectSpeechResults([[{transcript:'Начало задачи'}],[{transcript:'и последние слова'}]]),'Начало задачи и последние слова');
});
test('capture exceeds three minutes and drains every final blob before stopping tracks',async()=>{
  const made=[],events=[],delayed=[];
  class Recorder {
    constructor(){this.state='inactive';this.mimeType='audio/webm';this.id=made.length;made.push(this);}
    start(){this.state='recording';events.push(`start-${this.id}`);}
    stop(){if(this.state==='inactive')throw Error('double stop');this.state='inactive';queueMicrotask(()=>{events.push(`data-${this.id}`);this.ondataavailable({data:new Blob([`segment ${this.id}`])});this.onstop();});}
  }
  const jobs=[];let tracksStopped=false;
  const capture=new SegmentedCapture({stream:{getTracks:()=>[{stop(){tracksStopped=true;}}]},Recorder,onSegment:j=>jobs.push(j),segmentMs:60000,overlapMs:1200,timers:{setInterval:()=>1,clearInterval(){},setTimeout:fn=>delayed.push(fn)}});
  capture.start();
  for(let minute=1;minute<=5;minute++){capture.rotate();assert.ok(events.indexOf(`start-${minute}`)<events.indexOf(`data-${minute-1}`)||!events.includes(`data-${minute-1}`));delayed.shift()();await Promise.resolve();}
  await capture.stop();assert.equal(jobs.length,6);assert.ok(tracksStopped);assert.equal(jobs[5].index,5);
  assert.equal(await jobs[5].blob.text(),'segment 5');assert.ok(jobs.every(j=>j.blob.size>0));
});
test('out-of-order retries reconstruct the original order without duplicating inserted text',()=>{
  const jobs=[{index:2,status:'done',text:'Третья фраза'},{index:0,status:'done',text:'Первая фраза'},{index:1,status:'error',text:''}];
  assert.equal(joinSegments(jobs),'Первая фраза\nТретья фраза');
  jobs[2]={index:1,status:'done',text:'Вторая фраза'};
  assert.equal(joinSegments(jobs),'Первая фраза\nВторая фраза\nТретья фраза');
});
