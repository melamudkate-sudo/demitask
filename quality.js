export const QUALITY_SCHEMA = {
  type:'object',additionalProperties:false,
  properties:{
    level:{type:'string',enum:['green','yellow','red']},summary:{type:'string'},
    issues:{type:'array',items:{type:'object',additionalProperties:false,properties:{taskIndex:{type:'integer'},section:{type:'string',enum:['title','outcome','context','steps','requirements','acceptance','checklist']},detail:{type:'string'},suggestion:{type:'string'},quote:{type:'string'}},required:['taskIndex','section','detail','suggestion','quote']}}
  },required:['level','summary','issues']
};
export function assessQuality(result) {
  const issues=[];let red=false;
  [result.task,...result.subtasks].forEach((t,taskIndex)=>{
    if(!t.outcome.trim()||/требует уточнения|результат не определён/iu.test(t.outcome)){red=true;issues.push({taskIndex,section:'outcome',detail:'Не определён конечный продукт.',suggestion:'Опишите, что конкретно должно получиться.'});}
    if(!t.steps.length||/требует уточнения/iu.test(t.steps.join(' '))){red=true;issues.push({taskIndex,section:'steps',detail:'Неясен состав работ.',suggestion:'Уточните конкретное действие и предмет задачи.'});}
    if(!t.requirements.length)issues.push({taskIndex,section:'requirements',detail:'Нет дополнительных требований или материалов.',suggestion:'При необходимости добавьте источники, формат или ограничения.'});
    if(!t.acceptance.length)issues.push({taskIndex,section:'acceptance',detail:'Не указаны критерии проверки.',suggestion:'Добавьте, как проверить готовность результата.'});
  });
  return {level:red?'red':issues.length?'yellow':'green',summary:red?'Коллеге может быть неясно, что сделать или получить.':issues.length?'Задача понятна в общих чертах, но её можно уточнить.':'Действия, результат и проверка сформулированы.',issues};
}
export function validateQuality(value,result) {
  const sections=['title','outcome','context','steps','requirements','acceptance','checklist'];
  if(!value||!['green','yellow','red'].includes(value.level)||typeof value.summary!=='string'||!Array.isArray(value.issues))return assessQuality(result);
  const issues=value.issues.filter(i=>i&&Number.isInteger(i.taskIndex)&&i.taskIndex>=0&&i.taskIndex<=result.subtasks.length&&sections.includes(i.section)&&typeof i.detail==='string'&&typeof i.suggestion==='string').slice(0,16);
  if(value.level!=='green'&&!issues.length)return assessQuality(result);
  return {level:issues.length&&value.level==='green'?'yellow':value.level,summary:value.summary.slice(0,1200),issues};
}
