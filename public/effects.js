/* Original supplied effects, section-scoped and loaded only when needed. */
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const section=document.querySelector('.intro');
if(section&&!reduced.matches){
 const observer=new IntersectionObserver(entries=>{
  if(!entries.some(e=>e.isIntersecting))return;observer.disconnect();
  import('./blocky-grid.js').then(({startGrid})=>startGrid()).catch(()=>section.querySelector('canvas')?.remove());
 },{rootMargin:'450px'});observer.observe(section);
}
let inkStarted=false;
function ink(e){
 if(inkStarted||e.pointerType==='touch'||reduced.matches||!matchMedia('(any-pointer: fine)').matches)return;
 inkStarted=true;window.removeEventListener('pointermove',ink);
 import('./ink-brush.js').then(({startInk})=>startInk()).catch(()=>document.querySelector('.ink-trail')?.remove());
}
window.addEventListener('pointermove',ink,{passive:true});
