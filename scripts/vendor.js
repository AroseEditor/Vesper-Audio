const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const out = path.join(root, 'src', 'ui', 'vendor')
const nm = (...p) => path.join(root, 'node_modules', ...p)
const ns = nm('@sapphi-red', 'web-noise-suppressor', 'dist')
const ort = nm('onnxruntime-web', 'dist')
const fonts = nm('@fontsource', 'inter', 'files')

const copies = [
  [path.join(ns, 'index.js'), 'noise.js'],
  [path.join(ns, 'rnnoise', 'workletProcessor.js'), 'rnnoise.worklet.js'],
  [path.join(ns, 'rnnoise.wasm'), 'rnnoise.wasm'],
  [path.join(ns, 'rnnoise_simd.wasm'), 'rnnoise_simd.wasm'],
  [path.join(ns, 'speex.wasm'), 'speex.wasm'],
  [path.join(ort, 'ort.wasm.min.mjs'), 'ort.min.mjs'],
  [path.join(ort, 'ort-wasm-simd-threaded.mjs'), 'ort-wasm-simd-threaded.mjs'],
  [path.join(ort, 'ort-wasm-simd-threaded.wasm'), 'ort-wasm-simd-threaded.wasm'],
  [path.join(ort, 'ort.webgpu.min.mjs'), 'ort.webgpu.min.mjs'],
  [path.join(ort, 'ort-wasm-simd-threaded.asyncify.mjs'), 'ort-wasm-simd-threaded.asyncify.mjs'],
  [path.join(ort, 'ort-wasm-simd-threaded.asyncify.wasm'), 'ort-wasm-simd-threaded.asyncify.wasm'],
  ...[400, 500, 600, 700].map(w => [path.join(fonts, `inter-latin-${w}-normal.woff2`), `inter-${w}.woff2`])
]

fs.mkdirSync(out, { recursive: true })
for (const [from, to] of copies) fs.copyFileSync(from, path.join(out, to))

const obsSpeex = `const FRAME=480,RING=FRAME*16;
class ObsSpeex extends AudioWorkletProcessor{
constructor(options){
super();
const p=options.processorOptions;
this.level=typeof p.noiseSuppress==='number'?p.noiseSuppress:-30;
this.inBuf=new Float32Array(FRAME);
this.fill=0;
this.ring=new Float32Array(RING);
this.rp=0;
this.wp=0;
this.avail=0;
this.primed=false;
this.total=0;
this.state=null;
this.destroyed=false;
this.port.onmessage=e=>{if(e.data==='destroy')this.destroy();else if(typeof e.data==='number')this.level=e.data};
(async()=>{const m=await o({locateFile:e=>e,wasmBinary:p.wasmBinary});if(this.destroyed)return;this.state=new a(m,FRAME,sampleRate);this.state.denoise=true})()
}
process(inputs,outputs){
const input=inputs[0]&&inputs[0][0];
const output=outputs[0]&&outputs[0][0];
if(!output)return !this.destroyed;
const n=output.length;
this.total+=n;
if(input&&this.state){
for(let i=0;i<n;i++){
const v=input[i];
this.inBuf[this.fill++]=v>1?1:v<-1?-1:v;
if(this.fill===FRAME){
this.state.noiseSuppress=this.level;
this.state.process(this.inBuf);
for(let k=0;k<FRAME;k++){this.ring[this.wp]=this.inBuf[k];this.wp=(this.wp+1)%RING}
this.avail=Math.min(RING,this.avail+FRAME);
this.fill=0
}
}
}
if(!this.primed&&this.total>=FRAME+n&&this.avail>=n)this.primed=true;
if(this.primed&&this.avail>=n){
for(let i=0;i<n;i++){output[i]=this.ring[this.rp];this.rp=(this.rp+1)%RING}
this.avail-=n
}else{
output.fill(0);
this.primed=false
}
return !this.destroyed
}
destroy(){this.destroyed=true;if(this.state){this.state.destroy();this.state=null}}
}
registerProcessor('@sapphi-red/web-noise-suppressor/speex',ObsSpeex);`

const speexSrc = fs.readFileSync(path.join(ns, 'speex', 'workletProcessor.js'), 'utf8')
const startMarker = 'const s=(e,{bufferSize:t,maxChannels:n,sampleRate:r})=>{'
const endMarker = 'registerProcessor(`@sapphi-red/web-noise-suppressor/speex`,c);'
const start = speexSrc.indexOf(startMarker)
const end = speexSrc.indexOf(endMarker)
if (start < 0 || end < start) throw new Error('speex worklet layout changed, cannot rebuild the OBS processor')
const zeroPart = fs.readFileSync(path.join(__dirname, 'zero-speex.part.js'), 'utf8')
const registerObs = "registerProcessor('@sapphi-red/web-noise-suppressor/speex',ObsSpeex);"
const withZero = obsSpeex.replace(registerObs, zeroPart + '\n' + registerObs + "\nregisterProcessor('vesper-speex-zero',ZeroSpeex);")
const rebuilt = speexSrc.slice(0, start) + withZero + speexSrc.slice(end + endMarker.length)
fs.writeFileSync(path.join(out, 'speex.worklet.js'), rebuilt)
