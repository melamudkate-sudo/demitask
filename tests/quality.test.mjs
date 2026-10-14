import test from 'node:test';
import assert from 'node:assert/strict';
import {assessQuality,validateQuality} from '../quality.js';
const task={title:'Создать файл',outcome:'файл готов',context:'',steps:['Записать строку'],requirements:['UTF-8'],acceptance:['Проверить текст'],checklist:[],checklistTitle:''};
test('green, yellow and red assessments identify concrete sections',()=>{
  assert.equal(assessQuality({task,subtasks:[]}).level,'green');
  const yellow=assessQuality({task:{...task,requirements:[]},subtasks:[]});assert.equal(yellow.level,'yellow');assert.equal(yellow.issues[0].section,'requirements');
  const red=assessQuality({task:{...task,outcome:''},subtasks:[]});assert.equal(red.level,'red');assert.equal(red.issues[0].section,'outcome');
});
test('invalid AI highlight targets are filtered and an unexplained red indicator gets a fallback',()=>{
  const quality=validateQuality({level:'red',summary:'x',issues:[{taskIndex:88,section:'script',detail:'x',suggestion:'y'}]},{task,subtasks:[]});
  assert.equal(quality.level,'green');assert.deepEqual(quality.issues,[]);
});
