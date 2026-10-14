// Each segment is a complete playable file (not requestData slices of a WebM stream).
// Start the next recorder before stopping the previous one, retaining a short overlap.
export class SegmentedCapture {
  constructor({stream,Recorder,mimeType,onSegment,onError,segmentMs=60000,overlapMs=1200,timers=globalThis}) {
    Object.assign(this,{stream,Recorder,mimeType,onSegment,onError,segmentMs,overlapMs,timers});
    this.recorders=new Set();this.pendingStops=new Set();this.nextIndex=0;this.active=false;this.totalBytes=0;
  }
  startSegment() {
    const recorder=new this.Recorder(this.stream,this.mimeType?{mimeType:this.mimeType,audioBitsPerSecond:64000}:{audioBitsPerSecond:64000});
    const index=this.nextIndex++;const chunks=[];
    let resolve;const done=new Promise(r=>resolve=r);this.pendingStops.add(done);this.recorders.add(recorder);
    recorder.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);this.totalBytes+=e.data.size;}};
    recorder.onerror=e=>{this.onError?.(e);this.stop();};
    recorder.onstop=()=>{
      this.recorders.delete(recorder);
      const blob=new Blob(chunks,{type:recorder.mimeType||this.mimeType||'audio/webm'});
      if(blob.size)this.onSegment({index,blob,overlap:index>0});
      this.pendingStops.delete(done);resolve();
    };
    try{recorder.start(1000);}catch(e){this.recorders.delete(recorder);this.pendingStops.delete(done);resolve();throw e;}return recorder;
  }
  start() {this.active=true;this.current=this.startSegment();this.rotation=this.timers.setInterval(()=>this.rotate(),this.segmentMs);}
  rotate() {
    if(!this.active)return;
    const old=this.current;
    try {this.current=this.startSegment();}catch(e){this.onError?.(e);this.stop();return;}
    this.timers.setTimeout(()=>{if(old.state!=='inactive')old.stop();},this.overlapMs);
  }
  async stop() {
    this.active=false;this.timers.clearInterval(this.rotation);
    for(const recorder of this.recorders)if(recorder.state!=='inactive')recorder.stop();
    await Promise.all([...this.pendingStops]);
    this.stream.getTracks().forEach(t=>t.stop());
  }
  abort() {
    this.active=false;this.timers.clearInterval(this.rotation);
    for(const r of this.recorders){r.onstop=null;if(r.state!=='inactive')r.stop();}
    this.stream.getTracks().forEach(t=>t.stop());
  }
}

export function mergeTranscript(previous,next,overlap=false) {
  if(!previous.trim())return next.trim();if(!next.trim())return previous;
  if(!overlap)return previous.trimEnd()+'\n'+next.trim();
  const tokens=s=>[...s.matchAll(/[\p{L}\p{N}]+/gu)].map(m=>({word:m[0].toLocaleLowerCase('ru').replace(/ё/g,'е'),end:m.index+m[0].length}));
  const a=tokens(previous),b=tokens(next);
  for(let n=Math.min(30,a.length,b.length);n>=2;n--){
    if(a.slice(-n).every((t,i)=>t.word===b[i].word)){
      const rest=next.slice(b[n-1].end).replace(/^[\s,.;:!?—-]+/u,'');
      return (rest?previous.trimEnd().replace(/[.,;:!?]+$/u,''):previous.trimEnd())+(rest?' '+rest:'');
    }
  }
  return previous.trimEnd()+'\n'+next.trim();
}

export function collectSpeechResults(results) {
  // Include the last interim hypothesis on stop instead of silently dropping the final words.
  return Array.from(results,r=>r?.[0]?.transcript||'').filter(Boolean).join(' ').trim();
}

export function joinSegments(segments) {
  return [...segments].sort((a,b)=>a.index-b.index).reduce((text,s)=>s.status==='done'?mergeTranscript(text,s.text,s.overlap):text,'');
}
