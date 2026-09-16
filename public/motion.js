(()=>{
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const comparison=document.querySelector('.comparison-story');
if(reduced)return;
// The comparison is a scroll scene. Keep it out of one-shot heading/card reveals.
const heads=[...document.querySelectorAll('main:not(.dashboard-v2) h1,main:not(.dashboard-v2) h2,.footer-cta h2')].filter(h=>!h.closest('.comparison-story'));
heads.forEach(h=>{h.classList.remove('reveal','scroll-reveal');h.classList.add('bar-heading');let index=0;const walk=node=>[...node.childNodes].forEach(c=>{if(c.nodeType===3){const f=document.createDocumentFragment();c.textContent.split(/(\s+)/).forEach(word=>{if(!word.trim())f.append(document.createTextNode(word));else{const s=document.createElement('span');s.className='heading-word';s.style.setProperty('--word-i',Math.min(index++,9));s.textContent=word;f.append(s)}});c.replaceWith(f)}else if(c.nodeType===1&&c.tagName!=='BR')walk(c)});walk(h)});
const targets=[...document.querySelectorAll('.bar-heading,.work-card,.stair-cards article,.tech-grid a,.audience,.policy-card,.transparency-art,.disclosures details,.footer-cta,.mission-card,.wide-art,.value-grid article,.rail-grid article,.process-card,.outcomes-grid article,.price-reference,.transparency-ledger>div,.network-disclosure,.legal-links,.home-page-links,.next-page')];
const observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){e.target.classList.add('motion-entered');observer.unobserve(e.target)}},{threshold:0.12,rootMargin:'0px 0px -24px 0px'});
targets.forEach((e,i)=>{e.classList.add('motion-target');e.style.setProperty('--stagger',(e.parentElement?Array.from(e.parentElement.children).indexOf(e)%4:i%4)*85+'ms');observer.observe(e)});
document.querySelectorAll('.big-number').forEach(el=>{const label=el.textContent;el.setAttribute('aria-label',label);el.innerHTML=[...label].map((char,i)=>/\d/.test(char)?`<span class="digit-slot" aria-hidden="true"><span class="digit-reel" style="--digit:${Number(char)};--digit-delay:${i*90}ms">${Array.from({length:10},(_,n)=>`<i>${n}</i>`).join('')}</span></span>`:`<span aria-hidden="true">${char}</span>`).join('')});
const stack=[...document.querySelectorAll('.work-card')],intro=document.querySelector('.intro');let scheduled=false;
const clamp=(v,min=0,max=1)=>Math.max(min,Math.min(max,v));
function render(){scheduled=false;const vh=innerHeight;
if(innerWidth>700){stack.forEach((c,i)=>{const next=stack[i+1];if(!next)return;const overlap=clamp((vh-next.getBoundingClientRect().top)/(vh*.8));c.style.transform=`scale(${1-overlap*.035})`;c.style.filter=`brightness(${1-overlap*.12})`})}else stack.forEach(c=>{c.style.transform='';c.style.filter=''});
if(intro){const r=intro.getBoundingClientRect(),progress=clamp((vh-r.top)/(vh+r.height));intro.style.setProperty('--intro-shift',progress);intro.querySelectorAll('.heading-word').forEach((w,i,a)=>w.style.opacity=String(clamp((progress*1.9-i/a.length)*3,.22)))}
if(comparison){const r=comparison.getBoundingClientRect(),mobile=innerWidth<=700,stage=comparison.querySelector('.comparison-stage');const p=mobile?clamp((80-r.top)/(vh*.55)):clamp((80-r.top)/(r.height-stage.offsetHeight));const split=clamp((p-.06)/.52),cards=clamp((p-.14)/.54),ease=1-Math.pow(1-cards,3);comparison.style.setProperty('--comparison-split',split);comparison.style.setProperty('--comparison-distance',(mobile?innerWidth*.65:innerWidth*.48)+'px');comparison.style.setProperty('--comparison-cards',ease);comparison.style.setProperty('--comparison-rise',(1-ease)*Math.min(250,vh*.38)+'px');comparison.dataset.scene=p<.15?'title':p<.68?'revealing':'comparison';if(mobile)comparison.querySelectorAll('.compare-grid article').forEach((a,i)=>{const ar=a.getBoundingClientRect();a.classList.toggle('card-in-view',ar.top<vh*.9&&ar.bottom>0)})}
}
comparison?.classList.add('scroll-scene');
addEventListener('scroll',()=>{if(!scheduled){scheduled=true;requestAnimationFrame(render)}},{passive:true});addEventListener('resize',render);addEventListener('pageshow',render);render();
})();
