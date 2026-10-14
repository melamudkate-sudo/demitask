// Public names verified on demiand.ru on 2026-10-14. Private future products belong in browser storage.
export const GLOSSARY_VERSION = 2;
export const GLOSSARY_SOURCES = [
  'https://demiand.ru/catalog/aerogrili/', 'https://demiand.ru/catalog/blendery/',
  'https://demiand.ru/catalog/kofevarki/', 'https://demiand.ru/about/',
  'https://demiand.ru/catalog/blendery/blender-demixi-chernyy/',
  'https://demiand.ru/catalog/aerogrili/crispo-dk-2300-bezhevyy/',
  'https://demiand.ru/catalog/aerogrili/aerogril-tarvin-belyy/'
];
const model = (name,code,spoken,numbers) => ({id:code.toLowerCase(),term:`${name} ${code}`,aliases:[name,code,spoken,code.replace('-',' '),code.replace(/^[A-Z]+-/,'')+'',numbers].filter(Boolean).join(', '),note:`Модель DEMIAND. ${code}. Русские названия и их падежные формы означают эту модель; в результате использовать ${name} ${code}.`,kind:'model',inflect:true});
export const DEFAULT_TERMS = [
  {id:'demiand',term:'DEMIAND',aliases:'демианд, demiand',note:'Бренд и компания. В названиях писать DEMIAND.',inflect:true},
  model('DUOS','DK-2100','дуос','две тысячи сто'),
  model('SANDERS','DK-2200','сандерс, сэндерс','две тысячи двести'),
  model('SANDERS MAX','DK-2400','сандерс макс, сэндерс макс','две тысячи четыреста'),
  model('LEOCRISP','DK-2500','леокрисп, лео крисп','две тысячи пятьсот'),
  model('LUNEO','DK-2700','лунео','две тысячи семьсот'),
  model('HARRINGTON','DK-5100','харрингтон, харингтон','пять тысяч сто'),
  model('TARVIN','DK-5200','тарвин','пять тысяч двести'),
  model('KRISPER','DK-5300','криспер','пять тысяч триста'),
  model('WAISON','DK-1800','вайсон, уэйсон','тысяча восемьсот'),
  model('TISON','DK-1416','тайсон, тисон','тысяча четыреста шестнадцать'),
  model('CRISPO','DK-2300','криспо','две тысячи триста'),
  model('COMBO','DK-2600','комбо','две тысячи шестьсот'),
  model('DeMixi','BL-1200','демикси, де микси','тысяча двести'),
  model('RIVO','KF-3500','риво','три тысячи пятьсот'),
  model('LUNO','KF-3100','луно','три тысячи сто'),
  model('RETRO','KF-3200','ретро','три тысячи двести'),
  {id:'cook-ai',term:'Demiand Cook AI',aliases:'демианд кук ай, демианд кук эй ай, cook ai',note:'Умные программы приготовления в экосистеме DEMIAND.',inflect:false},
  {id:'demigram',term:'DEMIGRAM',aliases:'демиграм, демиграмм',note:'Кулинарная социальная сеть внутри приложения DEMIAND.',inflect:true},
  {id:'decube',term:'Decube',aliases:'декуб, декьюб, де куб',note:'Название экосистемы DEMIAND.',inflect:true},
  {id:'fast-hot-air',term:'Fast Hot Air',aliases:'фаст хот эйр, фаст хот аир',note:'Название технологии циркуляции горячего воздуха.',inflect:false},
  {id:'steam-fry-up',term:'Steam Fry-Up',aliases:'стим фрай ап, стим фрайап',note:'Название технологии приготовления с добавлением пара.',inflect:false},
  {id:'xblade',term:'XBlade Ultra',aliases:'икс блейд ультра, экс блейд ультра, иксблейд ультра',note:'Название технологии измельчения блендера DeMixi.',inflect:false},
  {id:'smart-lock',term:'Smart Lock',aliases:'смарт лок, смартлок',note:'Название системы безопасности. Не приписывать всем моделям.',inflect:false},
  {id:'wifi',term:'Wi-Fi',aliases:'вайфай, вай фай, wi fi, wifi',note:'Беспроводное подключение.',inflect:false},
  {id:'marketplace',term:'МП',aliases:'эм пэ, mp, мп',note:'Маркетплейс.',inflect:false},
  {id:'rich-content',term:'рич-контент',aliases:'rich, rich-контент, рич контент, рич-контент',note:'Расширенный контент карточки товара на маркетплейсе.',inflect:true,preserveEnding:true},
  {id:'wb',term:'WB',aliases:'вэ бэ, вб, вайлдбериз, вайлд бериз, вайлберис, wildberries',note:'Маркетплейс Wildberries.',inflect:true},
  {id:'ozon',term:'Ozon',aliases:'озон',note:'Маркетплейс Ozon.',inflect:true},
  {id:'yandex-market',term:'Я.Маркет',aliases:'яндекс маркет, я маркет, я.маркет',note:'Маркетплейс Яндекс Маркет.',inflect:true,preserveEnding:true},
  {id:'ckp',term:'ЦКП',aliases:'цкп, цэ ка пэ',note:'Ценный конечный продукт — проверяемый результат задачи.',inflect:false}
];

export function migrateTerms(saved, version = 0, removed = []) {
  const valid = Array.isArray(saved) ? saved.filter(t => t && ['id','term','aliases','note'].every(k=>typeof t[k]==='string')) : [];
  const cleaned = valid.filter(t=>t.id!=='luna' && !/^luna(?:\s+s)?$/i.test(t.term.trim()));
  if (version >= GLOSSARY_VERSION && Array.isArray(saved)) return cleaned;
  const existing = new Set(cleaned.map(t=>t.term.toLowerCase()));
  return [...cleaned,...DEFAULT_TERMS.filter(t=>!removed.includes(t.id)&&!cleaned.some(s=>s.id===t.id)&&!existing.has(t.term.toLowerCase()))].slice(0,120);
}

const escapeRE = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function forms(alias, inflect) {
  const variants = new Map([[alias,'']]);
  if (!inflect || !/[а-яё]$/i.test(alias)) return [...variants].map(([value,ending])=>({value,ending}));
  // Explicit Russian case endings for names ending in a consonant; no broad fuzzy stemming.
  const words = alias.split(/\s+/);
  if (words.every(w=>/^[а-яё]+$/iu.test(w) && /[бвгджзйклмнпрстфхцчшщ]$/iu.test(w))) {
    for (const ending of ['а','у','ом','е','ы','ов','ам','ами','ах']) variants.set(words.map(w=>w+ending).join(' '),ending);
  }
  for(let i=0;i<words.length;i++) if(/^[а-яё]+$/iu.test(words[i])&&/[бвгджзйклмнпрстфхцчшщ]$/iu.test(words[i])) {
    for(const ending of ['а','у','ом','е','ы','ов','ам','ами','ах'])variants.set(words.map((w,j)=>j===i?w+ending:w).join(' '),ending);
  }
  if (/[бвгджзйклмнпрстфхцчшщ]$/iu.test(alias)) for(const ending of ['а','у','ом','е','ы','ов','ам','ами','ах']) variants.set(alias+ending,ending);
  return [...variants].map(([value,ending])=>({value,ending}));
}
export function normalizeTerms(input, terms) {
  const matches=[];
  for(const entry of terms) {
    const aliases=[entry.term,...entry.aliases.split(',')].map(x=>x.trim()).filter(Boolean);
    for(const alias of aliases) for(const {value:variant,ending} of forms(alias,entry.inflect!==false)) {
      const re=new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRE(variant)}(?![\\p{L}\\p{N}_-])`,'giu');
      for(const match of input.matchAll(re)) {
        const start=match.index,end=start+match[0].length;
        if(/^\d+$/.test(variant)) {
          const around=input.slice(Math.max(0,start-40),Math.min(input.length,end+30));
          if(!/модел|аэрогрил|кофевар|блендер|карточк|demiand|демианд|\b[dkbf]{2}[- ]/iu.test(around)) continue;
          if(/^\s*(?:руб|₽|вт|w\b|px\b|пиксел|штук|шт\b|литр)/iu.test(input.slice(end))) continue;
        }
        matches.push({start,end,text:entry.term+(entry.preserveEnding?ending:'')});
      }
    }
  }
  matches.sort((a,b)=>a.start-b.start || b.end-a.end);
  let cursor=0,result='';
  for(const m of matches) { if(m.start<cursor)continue;result+=input.slice(cursor,m.start)+m.text;cursor=m.end; }
  return result+input.slice(cursor);
}

export function speechGlossary(terms, context='') {
  const relevant=terms.filter(t=>t.kind!=='model'||context.toLowerCase().includes(t.term.toLowerCase())||t.aliases.split(',').some(a=>a.trim()&&context.toLowerCase().includes(a.trim().toLowerCase())));
  const rest=terms.filter(t=>!relevant.includes(t));
  return [...relevant,...rest].map(t=>t.term).join(', ').slice(0,650);
}
