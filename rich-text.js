// Only these inert formatting tags are allowed in edited or generated descriptions.
const TAGS=new Set(['p','div','br','strong','b','em','i','u','h3','h4','ul','ol','li','blockquote','section']);
export function sanitizeRichHTML(value) {
  return String(value||'').replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|iframe|object|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').match(/<[^>]*>|[^<]+|</g)?.map(token=>{
    if(!token.startsWith('<'))return token;
    const tag=token.match(/^<(\/?)([a-z][a-z0-9]*)\b[^>]*>$/i);
    if(!tag)return token.replaceAll('<','&lt;');
    const name=tag[2].toLowerCase();return TAGS.has(name)?`<${tag[1]}${name}>`:'';
  }).join('')||'';
}
export function richText(value) {
  const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  return sanitizeRichHTML(value).replace(/<li>/g,'\n• ').replace(/<br>|<\/(?:p|div|h3|h4|ul|ol|li|blockquote|section)>/g,'\n').replace(/<[^>]*>/g,'').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,key)=>{
    if(key[0]!=='#')return entities[key.toLowerCase()];
    const number=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
    return number>0&&number<=0x10ffff?String.fromCodePoint(number):'';
  }).replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
