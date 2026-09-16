
import * as THREE from './vendor/three.module.js'


/* ============================================================
   CONFIG  — every tweakable value lives here. Colors are '#rrggbb'
   strings; everything else is a number. The UI panel + localStorage
   persistence are generated from these keys.
   A white-background emergence grid (NOT the house black bloom rig):
   glass tiles grow out of an empty white field in a diagonal sweep,
   a blue glow band travelling across them, fog fading the far rows to
   white — authored from refs/photo_2026-08-05_14-34-21.jpg ("blocky").
============================================================ */
export function startGrid(){
const CONFIG = {
  bgColor:      '#e2caf3',   // white field + tile TOPS — a flat seamless white at rest
  underColor:   '#99cce7',   // SKY-BLUE revealed on a tile's sides as it lifts
  edgeColor:    '#ffffff',   // bright rim that lights a raised tile's top edges
  shadeColor:   '#bc91d5',   // cool ambient on the exposed blue sides

  gridCols:      48,         // tiles across X
  gridRows:      50,         // tiles across Z
  spacing:       0.48,       // world distance between tile centres
  tileScale:     0.9,        // tile footprint vs spacing — gaps let blue show between raised tiles
  tileHeight:    0.34,       // extruded height (the blue side wall you reveal)

  riseHeight:    1.33,       // how high a tile pops under the cursor

  diffuse:       0.5,        // key-light on the exposed sides
  fresnel:       0.4,        // glassy top-edge sheen (only while lifted)
  edgeWidth:     0.09,       // top-edge rim thickness
  edgeGlow:      0.8,        // top-edge rim brightness
  underGlow:     1.5,        // how strongly the sides read blue when lifted

  pointerRadius: 3.8,        // cursor lift falloff — the reach of the raised area (world units)
  pointerLift:   1.0,        // how high tiles rise directly under the cursor
  pulseSpeed:    5.0,        // double-click ripple expansion speed
  pulseWidth:    1.7,        // double-click ripple thickness

  fogNear:       8.0,        // distance the white haze starts
  fogFar:        28.0,       // distance the field fully fades to white

  autoRotate:    0.1,        // idle camera drift speed (0 = camera fully still)
  orbitDrag:     0,          // 1 = mouse-drag orbits the camera (0 = mouse ONLY raises tiles)
  camDist:       9.5         // camera distance from the field — the ZOOM slider (scroll stays off)
}

/* ---------- HELPERS ---------- */
function hexToVec3(hex) {
  const n = parseInt(hex.slice(1), 16)
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/* ---------- RENDERER / SCENE / CAMERA ---------- */
const section = document.querySelector('.intro');
const canvas = section.querySelector('.privacy-grid');
const renderer = new THREE.WebGL1Renderer({ canvas, antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
const scene = new THREE.Scene()
scene.background = new THREE.Color(CONFIG.bgColor)
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 200)
camera.position.set(4.5, 11.5, 9)
scene.add(camera)

const target = new THREE.Vector3(0, .3, 0);
camera.position.sub(target).normalize().multiplyScalar(CONFIG.camDist).add(target);
camera.lookAt(target);
/* ============================================================
   SCENE: BLOCKY GRID
   An InstancedBufferGeometry of unit boxes laid on the XZ plane.
   Every tile's emergence (grow + rise), idle shimmer, cursor lift,
   glowing wireframe frame, travelling blue band and fog fade are all
   computed on the GPU from per-instance attributes (aGrid, aDelay,
   aRand) + a single uTime clock, so nothing is stepped per-tile on CPU.
============================================================ */
class BlockyGrid {
  constructor(scene) {
    this.scene = scene
    this.uniforms = {
      iTime:       { value: 0 },
      uCam:        { value: new THREE.Vector3() },
      uPointer:    { value: new THREE.Vector2(999, 999) },
      uBg:         { value: hexToVec3(CONFIG.bgColor) },
      uUnder:      { value: hexToVec3(CONFIG.underColor) },
      uEdge:       { value: hexToVec3(CONFIG.edgeColor) },
      uShade:      { value: hexToVec3(CONFIG.shadeColor) },
      uFogColor:   { value: hexToVec3(CONFIG.bgColor) },
      uTileW:      { value: CONFIG.spacing * CONFIG.tileScale },
      uHeight:     { value: CONFIG.tileHeight },
      uRiseHeight: { value: CONFIG.riseHeight },
      uDiffuse:    { value: CONFIG.diffuse },
      uFresnel:    { value: CONFIG.fresnel },
      uEdgeWidth:  { value: CONFIG.edgeWidth },
      uEdgeGlow:   { value: CONFIG.edgeGlow },
      uUnderGlow:  { value: CONFIG.underGlow },
      uPtrRadius:  { value: CONFIG.pointerRadius },
      uPtrLift:    { value: CONFIG.pointerLift },
      uPulseTime:  { value: new Array(8).fill(-999) },      // ring buffer of concurrent click ripples
      uPulseCenter:{ value: Array.from({ length: 8 }, () => new THREE.Vector2(0, 0)) },
      uPulseSpeed: { value: CONFIG.pulseSpeed },
      uPulseWidth: { value: CONFIG.pulseWidth },
      uFogNear:    { value: CONFIG.fogNear },
      uFogFar:     { value: CONFIG.fogFar },
      uLightDir:   { value: new THREE.Vector3(0.5, 0.62, 0.4).normalize() }
    }
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `
        precision highp float;
        attribute vec3 aGrid;
        attribute float aRand;
        uniform float iTime, uTileW, uHeight, uRiseHeight;
        uniform float uPtrRadius, uPtrLift, uPulseSpeed, uPulseWidth;
        uniform vec2 uPointer;
        uniform vec2 uPulseCenter[8];
        uniform float uPulseTime[8];
        varying vec3 vNormal, vWorld, vLocal;
        varying float vLift;

        void main(){
          vLocal = position;                                   // unit box in [-0.5,0.5]
          // the field lies FLAT and seamless white at rest — tiles only rise where the CURSOR is.
          // a compact smooth falloff (exactly 0 past uPtrRadius) keeps the rest of the field flat
          float pd = distance(aGrid.xz, uPointer);
          float f = clamp(1.0 - pd / uPtrRadius, 0.0, 1.0);
          float lift = uPtrLift * f * f * (3.0 - 2.0 * f);
          // overlapping click ripples — fast clicks stack in the ring buffer and each ring
          // runs its full life independently, so a new click never cuts off the previous one
          for (int i = 0; i < 8; i++) {
            float age = iTime - uPulseTime[i];
            if (age < 0.0 || age > 3.5) continue;
            float front = age * uPulseSpeed;
            float r = distance(aGrid.xz, uPulseCenter[i]);
            lift += exp(-pow((r - front) / uPulseWidth, 2.0)) * smoothstep(3.5, 0.0, age);
          }
          lift = clamp(lift, 0.0, 1.0);
          vLift = lift;
          vec3 sp = vec3(position.x * uTileW, position.y * uHeight, position.z * uTileW);
          vec3 wp = aGrid + sp;
          // at rest each tile sits JUST BELOW the white base plane (hidden → the field is one
          // even white); the wave lifts it up through the plane so its top + blue sides emerge
          wp.y += lift * uRiseHeight - (uHeight * 0.5 + 0.04);
          vNormal = position.y >  0.49 ? vec3(0.0, 1.0, 0.0)
                  : position.y < -0.49 ? vec3(0.0,-1.0, 0.0)
                  : normalize(vec3(position.x, 0.0, position.z));
          vWorld = wp;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        uniform vec3 uBg, uUnder, uEdge, uShade, uFogColor, uCam, uLightDir;
        uniform float uDiffuse, uFresnel, uEdgeWidth, uEdgeGlow, uUnderGlow, uFogNear, uFogFar;
        varying vec3 vNormal, vWorld, vLocal;
        varying float vLift;
        void main(){
          vec3 N = normalize(vNormal);
          vec3 V = normalize(uCam - vWorld);
          vec3 col;
          if (N.y > 0.5) {
            // TOP face — flat white at rest; a bright rim + glassy sheen only once lifted,
            // so the resting plane stays a perfectly even white with no visible squares
            col = uBg;
            vec3 a = 0.5 - abs(vLocal);
            float mx = max(a.x, max(a.y, a.z));
            float mn = min(a.x, min(a.y, a.z));
            float mid = a.x + a.y + a.z - mx - mn;
            float edge = 1.0 - smoothstep(0.0, uEdgeWidth, mid);
            float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
            col += (edge * uEdge * uEdgeGlow + fres * uFresnel * uUnder) * vLift;
          } else {
            // SIDE (and underside) — the SKY-BLUE that shows from beneath as tiles rise.
            // The whole side (colour AND shading) fades in from flat white with lift, so an
            // un-lifted tile's sides are pure white and the resting plane reads perfectly even.
            float dif = max(dot(N, uLightDir), 0.0);
            vec3 base = mix(uBg, uUnder, clamp(vLift * uUnderGlow, 0.0, 1.0));
            vec3 lit = base * (uShade + dif * uDiffuse);
            col = mix(uBg, lit, clamp(vLift, 0.0, 1.0));
          }
          float fog = smoothstep(uFogNear, uFogFar, distance(uCam, vWorld));
          col = mix(col, uFogColor, fog);
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.FrontSide
    })
    // Solid white base plane just under the tile tops — hides the hairline seams
    // between abutting tiles so the resting field reads as one perfectly even white,
    // and backs the gaps a lifted tile opens up (its blue sides sit above this plane).
    this.base = new THREE.Mesh(
      new THREE.PlaneBufferGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(CONFIG.bgColor) })
    )
    this.base.rotation.x = -Math.PI / 2
    scene.add(this.base)
    this.pulseIdx = 0
    this.shapeSig = ''
    this.build()
  }

  build() {
    const cols = CONFIG.gridCols, rows = CONFIG.gridRows, sp = CONFIG.spacing
    const sig = cols + 'x' + rows + 'x' + sp.toFixed(3)
    if (sig === this.shapeSig) return
    this.shapeSig = sig
    if (this.mesh) { this.scene.remove(this.mesh); this.geometry.dispose() }

    const box = new THREE.BoxGeometry(1, 1, 1)
    const geo = new THREE.InstancedBufferGeometry()
    geo.index = box.index
    geo.setAttribute('position', box.attributes.position)
    geo.setAttribute('normal', box.attributes.normal)

    const count = cols * rows
    const grid = new Float32Array(count * 3)
    const rand = new Float32Array(count)
    const ox = (cols - 1) * 0.5, oz = (rows - 1) * 0.5
    let i = 0
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        grid[i * 3]     = (c - ox) * sp
        grid[i * 3 + 1] = 0
        grid[i * 3 + 2] = (r - oz) * sp
        const jit = (Math.sin(c * 12.9898 + r * 78.233) * 43758.5453) % 1
        rand[i] = jit < 0 ? jit + 1 : jit
        i++
      }
    }
    geo.setAttribute('aGrid', new THREE.InstancedBufferAttribute(grid, 3))
    geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 1))
    geo.instanceCount = count

    this.geometry = geo
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.frustumCulled = false                                // custom vertex positions
    this.scene.add(this.mesh)

    const ext = Math.max(cols, rows) * sp * 1.4                    // cover the whole field + margin
    this.base.scale.set(ext, ext, 1)
    this.base.position.y = 0                                       // the flat white resting surface
  }

  // a click sends an expanding ripple ring out from the point that was clicked; each click
  // takes the next ring-buffer slot so rapid clicks stack instead of interrupting one another
  pulse(x, z) {
    const i = this.pulseIdx
    this.uniforms.uPulseCenter.value[i].set(x, z)
    this.uniforms.uPulseTime.value[i] = this.uniforms.iTime.value
    this.pulseIdx = (i + 1) % 8
  }

  resize() {}

  render() {
    this.uniforms.iTime.value = performance.now() / 1000
    this.uniforms.uCam.value.copy(camera.position)
  }
}

const sceneObj = new BlockyGrid(scene)

/* ---------- POINTER LIFT (raycast onto the y=0 plane) ---------- */
const raycaster = new THREE.Raycaster()
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const ndc = new THREE.Vector2()
const hit = new THREE.Vector3()
function pointer(e) {
  const r = section.getBoundingClientRect();
  ndc.set((e.clientX-r.left)/r.width*2-1, -(e.clientY-r.top)/r.height*2+1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(groundPlane, hit);
}
// Smooth position and hover pressure separately: no jump on entry, no snap on exit.
const pointerTarget = new THREE.Vector2();
const pointerCurrent = new THREE.Vector2();
let hoverTarget = 0, hoverStrength = 0, pointerInitialized = false, lastFrame = 0;
section.addEventListener('pointermove', e => {
 if(e.pointerType==='touch'||!pointer(e))return;
 pointerTarget.set(hit.x,hit.z);
 if(!pointerInitialized){pointerCurrent.copy(pointerTarget);pointerInitialized=true;}
 hoverTarget=1;
}, {passive:true});
section.addEventListener('pointerleave', () => {hoverTarget=0;});
window.addEventListener('blur', () => {hoverTarget=0;});
section.addEventListener('click', e => {if (pointer(e)) sceneObj.pulse(hit.x,hit.z);});

let visible = false, frame = 0, started = false, lost = false;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
function resize() {
 const w=section.clientWidth,h=section.clientHeight;
 renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();
 if(reduced.matches) renderer.render(scene,camera);
}
function draw(){
 frame=0;
 if(!visible || document.hidden || reduced.matches || lost)return;
 const now=performance.now(),dt=Math.min(.05,(now-(lastFrame||now))/1000);lastFrame=now;
 // Exponential easing is independent of refresh rate. Position follows over 140ms,
 // pressure rises over 220ms and releases over 380ms for a soft trailing settle.
 pointerCurrent.lerp(pointerTarget,1-Math.exp(-dt/.14));
 hoverStrength+=(hoverTarget-hoverStrength)*(1-Math.exp(-dt/(hoverTarget?.22:.38)));
 if(hoverStrength<.001&&!hoverTarget){hoverStrength=0;pointerInitialized=false;}
 sceneObj.uniforms.uPointer.value.copy(pointerCurrent);
 sceneObj.uniforms.uPtrLift.value=CONFIG.pointerLift*hoverStrength;
 sceneObj.render();renderer.render(scene,camera);
 frame=requestAnimationFrame(draw);
}
function resume(){if(!frame)draw();}
new ResizeObserver(resize).observe(section);resize();
new IntersectionObserver(entries=>{
 visible=entries[0].isIntersecting;
 if(visible&&!started&&!reduced.matches){started=true;sceneObj.render();sceneObj.pulse(0,0);}
 resume();
},{rootMargin:'80px'}).observe(section);
document.addEventListener('visibilitychange',()=>{if(document.hidden)hoverTarget=0;lastFrame=0;resume();});reduced.addEventListener('change',()=>{resize();resume()});
canvas.addEventListener('webglcontextlost',()=>{lost=true;canvas.style.opacity='0';});
canvas.addEventListener('webglcontextrestored',()=>{lost=false;canvas.style.opacity='';resume();});
canvas.dataset.effect='blocky-grid';

}
