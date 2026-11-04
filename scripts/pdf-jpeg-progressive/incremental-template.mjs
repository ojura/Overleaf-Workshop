// Source template appended to the pinned worker by prepare.py.
class IncrementalJpegImage extends JpegImage {
  constructor({maxInputBytes=16*1024*1024,maxPixels=16*1024*1024,maxCoefficientBytes=64*1024*1024,signal}={}) {
    super(); this.limits={maxInputBytes,maxPixels,maxCoefficientBytes};
    this._buffer=new Uint8Array(0);this._length=0;this._ended=false;this._closed=false;this._done=false;
    this._frame=null;this._quantizationTables=[];this.components=[];
    this.entropyCalls=0;this.entropyMs=0;this.renderMs=0;this.peakAccountedBytes=0;
    this._iterator=this._parse();this._signal=signal;this._abort=()=>this.cancel();
    signal?.addEventListener('abort',this._abort,{once:true});
    if(signal?.aborted)this.cancel();
  }
  _check(){if(this._closed)throw new DOMException('Incremental JPEG canceled','AbortError');}
  get coefficientBytes(){return this._frame?.components.reduce((n,c)=>n+c.blockData.byteLength,0)||0;}
  get inputCapacity(){return this._buffer.byteLength;}
  _account(extra=0){this.peakAccountedBytes=Math.max(this.peakAccountedBytes,this.inputCapacity+this.coefficientBytes+extra);}
  push(chunk,{final=false}={}) {
    this._check();if(this._done||this._ended)throw new Error('Input already ended');
    if(!(chunk instanceof Uint8Array))throw new TypeError('Expected byte chunk');
    const end=this._length+chunk.length;
    if(end>this.limits.maxInputBytes)throw new RangeError('JPEG input limit');
    if(end>this._buffer.length){
      const capacity=Math.min(this.limits.maxInputBytes,Math.max(end,65536,this._buffer.length*2));
      const replacement=new Uint8Array(capacity);replacement.set(this._buffer.subarray(0,this._length));
      this._account(capacity);this._buffer=replacement;
    }
    this._buffer.set(chunk,this._length);this._length=end;this._ended=final;this._account();
  }
  next(){
    this._check();if(this._done)return {type:'done'};
    try{const r=this._iterator.next();if(r.done)this._done=true;return r.value;}
    catch(error){this.cancel();throw error;}
  }
  _receivedView(){
    if(this._viewLength===this._length&&this._viewBuffer===this._buffer)return this._view;
    const bytes=this._buffer.subarray(0,this._length);
    this._viewBuffer=this._buffer;this._viewLength=this._length;
    this._view=new Proxy(bytes,{get(target,key){
      if(typeof key==='string'&&/^-?\d+$/.test(key)){
        const index=Number(key);
        if(index<0||index>=target.length)throw new JpegError('Parser read beyond received bytes');
      }
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }});
    return this._view;
  }
  *_need(count){
    if(!Number.isSafeInteger(count)||count<0||count>this.limits.maxInputBytes)throw new RangeError('JPEG input boundary');
    this._check();
    while(this._length<count){
      if(this._ended)throw new JpegError('Truncated received JPEG');
      yield {type:'need',minimum:count};this._check();
    }
    return this._receivedView();
  }
  *_scan(start){
    let cursor=start;
    for(;;){
      let data=yield* this._need(cursor+1);
      const marker=data.indexOf(255,cursor);
      if(marker<0){cursor=data.length;continue;}
      let after=marker+1;
      data=yield* this._need(after+1);
      while(data[after]===255){after++;data=yield* this._need(after+1);}
      const code=data[after];
      if(code===0||(code>=208&&code<=215)){cursor=after+1;continue;}
      return {data:data.subarray(0,after+1),end:marker};
    }
  }
  _validateFrame(frame){
    const {maxPixels,maxCoefficientBytes}=this.limits;
    if(frame.precision!==8||!frame.scanLines||!frame.samplesPerLine||frame.samplesPerLine*frame.scanLines>maxPixels)throw new RangeError('JPEG pixel limit');
    if(!frame.components.length||frame.components.length>4||frame.components.some(c=>c.h<1||c.h>4||c.v<1||c.v>4))throw new RangeError('JPEG sampling limit');
    const mx=Math.ceil(frame.samplesPerLine/8/frame.maxH),my=Math.ceil(frame.scanLines/8/frame.maxV);
    const bytes=frame.components.reduce((n,c)=>n+64*my*c.v*(mx*c.h+1)*2,0);
    if(bytes>maxCoefficientBytes)throw new RangeError('JPEG coefficient limit');
  }
  render({width,height}) {
    this._check();if(!this._frame||!this.entropyCalls)throw new Error('No completed scan');
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>this.limits.maxPixels)throw new RangeError('Preview pixel limit');
    const start=performance.now();
    try {
      this.components=this._frame.components.map(component=>{
        const copy={...component,blockData:component.blockData.slice(),quantizationTable:this._quantizationTables[component.quantizationId]};
        return {index:component.index,output:buildComponentData(this._frame,copy),scaleX:component.h/this._frame.maxH,scaleY:component.v/this._frame.maxV,blocksPerLine:component.blocksPerLine,blocksPerColumn:component.blocksPerColumn};
      });
      this._account(this.coefficientBytes+width*height*3);
      return super.getData({width,height,forceRGB:true,isSourcePDF:true});
    } finally {this.components=[];this.renderMs+=performance.now()-start;}
  }
  cancel(){
    if(this._closed)return;this._closed=true;this._iterator.return();
    this._buffer=new Uint8Array(0);this._length=0;this._frame=null;this._quantizationTables=[];this.components=[];
    this._view=null;this._viewBuffer=null;this._viewLength=-1;
    this._signal?.removeEventListener('abort',this._abort);
  }
  /* RESUMABLE_PARSE */
}
