
import * as THREE from './vendor/three.module.js'

/* ============================================================
   CONFIG  — every tweakable value lives here. Colors are '#rrggbb'
   strings; everything else is a number. The UI panel + localStorage
   persistence are generated from these keys.

   Ink Brush is an EXCEPTION-RIG scene (like Rift Stone):
   the visual is a GPU ping-pong FEEDBACK BUFFER, not the 3-composer
   bloom pipeline. Two UnsignedByte render targets hold a scalar "wetness"
   field; each frame the update pass diffuses (bleeds) + decays (dries) it
   and stamps fresh ink along the pointer's path; the display pass reads
   that field and paints ragged black ink over the orange field. No bloom,
   no corner flames — an ink-on-paper look wants neither.
============================================================ */
export function startInk(){
const CONFIG = {
  bgColor:    '#000000',   // orange paper
  inkColor:   '#bf8ade',   // near-black warm ink
  brushSize:  0.012,       // stamp radius (fraction of frame height)
  deposit:    1.10,        // ink laid down per frame while moving
  smear:      5.5,         // extra ink per unit pointer speed (the "мазок")
  decay:      0.94,       // per-frame ink retention (lower = dries/vanishes faster)
  diffuse:    0.16,        // bleed — how much ink spreads into neighbours
  edgeRagged: 0.18,        // how deckled/organic the ink boundary is (kept subtle so it never tears)
  threshold:  0.42,        // wetness level that reads as solid ink
  bleedHalo:  0.40,        // soft brown wet halo just outside the ink
  splatter:   0.18,        // stray droplets flung off fast strokes
  inkTexture: 0.28,        // mottled variation inside the ink
  paperGrain: 0.06,        // fine tooth on the orange field
  vignette:   0.30,        // corner darkening
  clickBlot:  1.6          // extra ink dropped by a press/click
}

/* ---------- HELPERS ---------- */
function hexToVec3(hex) {
  const n = parseInt(hex.slice(1), 16)
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

// Shared GLSL noise library (value-noise fbm) used by both passes.
const NOISE_GLSL = `
  float hash21(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    float a = hash21(i), b = hash21(i + vec2(1.,0.)), c = hash21(i + vec2(0.,1.)), d = hash21(i + vec2(1.,1.));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p *= 2.02; a *= 0.5; } return s; }
  float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0); return length(pa - ba * h); }
`

/* ---------- RENDERER / SCENE / CAMERA ---------- */
const canvas = document.createElement('canvas');
canvas.className='ink-trail';canvas.setAttribute('aria-hidden','true');document.body.append(canvas);
const renderer = new THREE.WebGL1Renderer({ canvas, alpha: true, antialias: false, powerPreference: 'high-performance' })
renderer.setPixelRatio(1)                       // sim + display are full-frame quads; DPR is handled per-target
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 10)
camera.position.set(0, 0, 1)                     // the fullscreen quad writes clip-space directly; camera is nominal
scene.add(camera)

const FS_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`

/* ============================================================
   SCENE: INK BRUSH
   A GPU ping-pong ink field. constructor() builds the two render
   targets + the update/display materials; resize() rebuilds the
   targets at the new size; render() advances the sim and updates
   the display uniforms.
============================================================ */
class InkBrushScene {
  constructor(scene) {
    this.dpr = Math.min(1, 1100 / window.innerWidth)
    this.simW = Math.max(2, Math.round(window.innerWidth * this.dpr))
    this.simH = Math.max(2, Math.round(window.innerHeight * this.dpr))

    // Half-float targets give a smooth (non-stepped) fade — 8-bit quantised the
    // decay into visible steps, which is what made fading marks look "clipped".
    // Fall back to byte where the extensions aren't available.
    this.rtType = THREE.UnsignedByteType
    try {
      const ext = renderer.extensions
      if (ext.get('OES_texture_half_float') && ext.get('OES_texture_half_float_linear') && ext.get('EXT_color_buffer_half_float')) {
        this.rtType = THREE.HalfFloatType
      }
    } catch (e) {}

    // CPU spatter droplets flung off the stroke each frame → uploaded as a vec3[] (x, y, radius)
    this.MAXDROPS = 24
    this.dropsArr = new Float32Array(this.MAXDROPS * 3)
    this.dropCount = 0

    // --- ping-pong render targets (scalar wetness in .r) ---
    this.rtA = this._makeRT(this.simW, this.simH)
    this.rtB = this._makeRT(this.simW, this.simH)
    this.read = this.rtA
    this.write = this.rtB
    this._clearRT(this.rtA); this._clearRT(this.rtB)

    // --- offscreen update scene ---
    this.simScene = new THREE.Scene()
    this.updateUniforms = {
      uPrev:       { value: this.read.texture },
      uResolution: { value: new THREE.Vector2(this.simW, this.simH) },
      uP0:         { value: new THREE.Vector2(0.5, 0.5) },
      uP1:         { value: new THREE.Vector2(0.5, 0.5) },
      uActive:     { value: 0 },
      uSpeed:      { value: 0 },
      uRadius:     { value: CONFIG.brushSize },
      uDeposit:    { value: CONFIG.deposit },
      uSmear:      { value: CONFIG.smear },
      uDecay:      { value: CONFIG.decay },
      uDiffuse:    { value: CONFIG.diffuse },
      uDrops:      { value: this.dropsArr },
      uDropCount:  { value: 0 },
      uClick:      { value: 0 },
      uTime:       { value: 0 }
    }
    this.updateMat = new THREE.ShaderMaterial({
      uniforms: this.updateUniforms,
      vertexShader: FS_VERT,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uPrev;
        uniform vec2 uResolution, uP0, uP1;
        uniform float uActive, uSpeed, uRadius, uDeposit, uSmear, uDecay, uDiffuse, uClick, uTime;
        uniform vec3 uDrops[24];
        uniform int uDropCount;
        ${NOISE_GLSL}
        void main(){
          vec2 uv = vUv;
          vec2 texel = 1.0 / uResolution;

          // --- diffuse (ink bleed) then decay (drying / it is temporary) ---
          float c = texture2D(uPrev, uv).r;
          float n = texture2D(uPrev, uv + vec2(0.0, texel.y)).r;
          float s = texture2D(uPrev, uv - vec2(0.0, texel.y)).r;
          float e = texture2D(uPrev, uv + vec2(texel.x, 0.0)).r;
          float w = texture2D(uPrev, uv - vec2(texel.x, 0.0)).r;
          float blur = (n + s + e + w) * 0.25;
          float val = mix(c, blur, clamp(uDiffuse, 0.0, 1.0));
          val *= uDecay;

          // --- deposit fresh ink along the pointer segment (aspect-correct) ---
          float aspect = uResolution.x / uResolution.y;
          vec2 p = vec2(uv.x * aspect, uv.y);
          vec2 a = vec2(uP0.x * aspect, uP0.y);
          vec2 b = vec2(uP1.x * aspect, uP1.y);
          float d = sdSeg(p, a, b);

          // organic wobble on the stamp radius so the blot never reads as a clean disc
          float ang = atan(p.y - b.y, p.x - b.x);
          float wob = fbm(vec2(ang * 1.6 + 3.0, uTime * 0.6));
          float r = uRadius * (0.72 + 0.7 * wob) * (1.0 + uClick * 1.4);

          float amount = uDeposit * (0.55 + uSmear * uSpeed) + uClick;
          float stamp = smoothstep(r, r * 0.15, d) * amount * uActive;
          val += stamp;

          // --- spatter: discrete round droplets spawned CPU-side, flung off the stroke ---
          for (int i = 0; i < 24; i++) {
            if (i >= uDropCount) break;
            vec3 dp = uDrops[i];
            vec2 dpos = vec2(dp.x * aspect, dp.y);
            float dr = max(dp.z, 1e-4);
            float ds = 1.0 - smoothstep(dr * 0.45, dr, length(p - dpos));
            val = max(val, ds);                       // solid round dot; max so overlaps don't blow out
          }

          gl_FragColor = vec4(clamp(val, 0.0, 1.0), 0.0, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false
    })
    this.simQuad = new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2), this.updateMat)
    this.simQuad.frustumCulled = false
    this.simScene.add(this.simQuad)

    // --- visible display quad ---
    this.displayUniforms = {
      uTrail:      { value: this.read.texture },
      uResolution: { value: new THREE.Vector2(this.simW, this.simH) },
      uBg:         { value: hexToVec3(CONFIG.bgColor) },
      uInk:        { value: hexToVec3(CONFIG.inkColor) },
      uEdge:       { value: CONFIG.edgeRagged },
      uThreshold:  { value: CONFIG.threshold },
      uHalo:       { value: CONFIG.bleedHalo },
      uInkTex:     { value: CONFIG.inkTexture },
      uPaper:      { value: CONFIG.paperGrain },
      uVig:        { value: CONFIG.vignette },
      uAppear:     { value: 0 },
      uTime:       { value: 0 }
    }
    this.material = new THREE.ShaderMaterial({
      uniforms: this.displayUniforms,
      transparent: true,
      vertexShader: FS_VERT,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTrail;
        uniform vec2 uResolution;
        uniform vec3 uBg, uInk;
        uniform float uEdge, uThreshold, uHalo, uInkTex, uPaper, uVig, uAppear, uTime;
        ${NOISE_GLSL}
        void main(){
          vec2 uv = vUv;
          float aspect = uResolution.x / uResolution.y;
          vec2 sp = vec2(uv.x * aspect, uv.y);

          float t = texture2D(uTrail, uv).r;

          // deckled ink boundary — HIGH-freq, low-amplitude noise only nibbles the rim.
          // Amplitude (±uEdge/2) is kept < the smoothstep band width, so the noise can
          // never carve through and detach islands — a fading mark just dissolves.
          float edge = fbm(sp * 16.0 + 11.0) * 0.65 + fbm(sp * 33.0 + 4.0) * 0.35;
          float mott = fbm(sp * 23.0 + t * 3.0 + uTime * 0.05);
          float v = t + (edge - 0.5) * uEdge;
          float ink = smoothstep(uThreshold - 0.12, uThreshold + 0.10, v);

          // orange field with a faint paper tooth
          float paper = hash21(floor(gl_FragCoord.xy)) - 0.5;
          vec3 bg = uBg + paper * uPaper;

          // ink body, slightly mottled so big blots aren't flat
          vec3 inkCol = uInk + (mott - 0.5) * uInkTex * vec3(0.07, 0.05, 0.035);

          vec3 col = mix(bg, inkCol, ink);

          // wet bleed halo — a darker/warmer ring just outside the solid ink
          float wet = smoothstep(0.03, uThreshold, t) * (1.0 - ink);
          col = mix(col, mix(uBg, uInk, 0.5), wet * uHalo);

          // vignette + entrance fade
          float vig = smoothstep(1.35, 0.35, length(uv - 0.5) * 2.0);
          col *= mix(1.0, vig, uVig);
          col *= uAppear;

          gl_FragColor = vec4(inkCol, clamp((ink + wet * uHalo) * uAppear * .48, 0.0, .48));
        }`,
      depthTest: false, depthWrite: false
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2), this.material)
    this.mesh.frustumCulled = false
    scene.add(this.mesh)

    // --- pointer state (uv space, y up) ---
    this.pCur = { x: 0.5, y: 0.5 }
    this.pPrev = { x: 0.5, y: 0.5 }
    this.movedFrame = false
    this.lastMove = -10
    this.clickEnv = 0
    this._bindPointer()

    this.appearStart = performance.now()
    this.lastT = performance.now() / 1000
  }

  _makeRT(w, h) {
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: this.rtType,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false
    })
  }

  _clearRT(rt) {
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(rt)
    renderer.setClearColor(0x000000, 1); renderer.clear(true, false, false)
    renderer.setRenderTarget(prev)
  }

  _bindPointer() {
    const move = (cx, cy) => {
      const x = cx / window.innerWidth
      const y = 1.0 - cy / window.innerHeight
      const now = performance.now() / 1000
      if (now - this.lastMove > 0.12) this.pPrev = { x, y }   // idle gap → start a fresh dot, not a long line
      this.pCur = { x, y }
      this.lastMove = now
      this.movedFrame = true
    }
    window.addEventListener('pointermove', e => {if(e.pointerType==='touch'||disabled())return; move(e.clientX,e.clientY); wake();}, {passive:true})
    window.addEventListener('pointerdown', e => {
      if(e.pointerType==='touch'||disabled())return;
      wake();
      const x = e.clientX / window.innerWidth, y = 1.0 - e.clientY / window.innerHeight
      this.pPrev = { x, y }; this.pCur = { x, y }
      this.movedFrame = true
      this.clickEnv = 1.0                                     // press drops a heavier blot
    }, { passive: true })
  }

  resize() {
    this.dpr = Math.min(1, 1100 / window.innerWidth)
    this.simW = Math.max(2, Math.round(window.innerWidth * this.dpr))
    this.simH = Math.max(2, Math.round(window.innerHeight * this.dpr))
    this.rtA.setSize(this.simW, this.simH)
    this.rtB.setSize(this.simW, this.simH)
    this._clearRT(this.rtA); this._clearRT(this.rtB)
    this.updateUniforms.uResolution.value.set(this.simW, this.simH)
    this.displayUniforms.uResolution.value.set(this.simW, this.simH)
  }

  render() {
    const t = performance.now() / 1000
    const dt = Math.min(0.05, t - this.lastT)
    this.lastT = t
    const dtn = dt * 60.0                                     // frame-rate normaliser (target 60fps)

    // pointer segment for this frame
    const p1 = this.pCur, p0 = this.pPrev
    const speed = Math.hypot(p1.x - p0.x, p1.y - p0.y)
    const active = this.movedFrame ? 1 : 0

    // click envelope decays over a few frames
    this.clickEnv *= Math.pow(0.82, dtn)
    if (this.clickEnv < 0.001) this.clickEnv = 0

    const U = this.updateUniforms
    U.uP0.value.set(p0.x, p0.y)
    U.uP1.value.set(p1.x, p1.y)
    U.uActive.value = active
    U.uSpeed.value = speed
    U.uRadius.value = CONFIG.brushSize
    U.uDeposit.value = CONFIG.deposit * dtn
    U.uSmear.value = CONFIG.smear
    U.uDecay.value = Math.pow(CONFIG.decay, dtn)              // time-correct fade
    U.uDiffuse.value = Math.min(0.5, CONFIG.diffuse * dtn)
    U.uClick.value = this.clickEnv * CONFIG.clickBlot * (active ? 1 : 0)
    U.uTime.value = t
    U.uPrev.value = this.read.texture

    // --- spawn natural spatter: droplets flung ahead & to the sides of the stroke ---
    this.dropCount = 0
    if (active && speed > 0.006 && CONFIG.splatter > 0.001) {
      const aspect = this.simW / this.simH
      const ax1 = p1.x * aspect, ay1 = p1.y
      let dx = (p1.x - p0.x) * aspect, dy = p1.y - p0.y
      const seg = Math.hypot(dx, dy) || 1
      dx /= seg; dy /= seg                                   // stroke direction
      const nx = -dy, ny = dx                                // perpendicular
      const bs = CONFIG.brushSize
      const n = Math.min(this.MAXDROPS, Math.floor(speed * 55 * CONFIG.splatter * (0.6 + Math.random())))
      for (let i = 0; i < n; i++) {
        const fwd  = (0.1 + 0.9 * Math.random()) * (speed * 2.5 + bs * 1.5)   // thrown ahead
        const side = (Math.random() * 2 - 1)     * (speed * 3.0 + bs * 2.0)   // scattered sideways
        const rad  = bs * (0.05 + 0.30 * Math.pow(Math.random(), 3.0))        // power-law → mostly tiny
        const k = this.dropCount * 3
        this.dropsArr[k]     = (ax1 + dx * fwd + nx * side) / aspect
        this.dropsArr[k + 1] =  ay1 + dy * fwd + ny * side
        this.dropsArr[k + 2] =  rad
        this.dropCount++
      }
    }
    U.uDropCount.value = this.dropCount

    // --- run the update pass into the write target, then swap ---
    const prevTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(this.write)
    renderer.render(this.simScene, camera)
    renderer.setRenderTarget(prevTarget)
    const tmp = this.read; this.read = this.write; this.write = tmp

    // carry this frame's end point into next frame → continuous strokes
    this.pPrev = { x: p1.x, y: p1.y }
    this.movedFrame = false

    // --- update display uniforms ---
    this.displayUniforms.uTrail.value = this.read.texture
    this.displayUniforms.uTime.value = t
    const elapsed = performance.now() - this.appearStart
    this.displayUniforms.uAppear.value = Math.max(0, Math.min(1, elapsed / 700))
  }
}

const sceneObj = new InkBrushScene(scene)


let frame=0,lastInput=0,lost=false;
const reduced=matchMedia('(prefers-reduced-motion: reduce)'),fine=matchMedia('(any-pointer: fine)');
function disabled(){return reduced.matches||!fine.matches||document.hidden||lost;}
function resize(){renderer.setSize(innerWidth,innerHeight,false);sceneObj.resize();renderer.setClearColor(0x000000,0);renderer.clear();}
function draw(){
 frame=0;
 if(disabled()||performance.now()-lastInput>1500){renderer.setRenderTarget(null);renderer.setClearColor(0x000000,0);renderer.clear();return;}
 sceneObj.render();renderer.setRenderTarget(null);renderer.setClearColor(0x000000,0);renderer.render(scene,camera);
 frame=requestAnimationFrame(draw);
}
function wake(){lastInput=performance.now();if(!frame)draw();}
function clear(){sceneObj._clearRT(sceneObj.rtA);sceneObj._clearRT(sceneObj.rtB);renderer.setRenderTarget(null);renderer.setClearColor(0x000000,0);renderer.clear();sceneObj.lastMove=-10;}
window.addEventListener('resize',resize);window.addEventListener('blur',clear);
document.addEventListener('visibilitychange',clear);reduced.addEventListener('change',clear);fine.addEventListener('change',clear);
canvas.addEventListener('webglcontextlost',()=>{lost=true;canvas.style.opacity='0';});
canvas.addEventListener('webglcontextrestored',()=>{lost=false;canvas.style.opacity='';resize();});
resize();canvas.dataset.effect='ink-brush';

}
