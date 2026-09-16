/* Hidden by default: internal navigation never paints a preloader, even briefly. */
(()=>{
 const arrival=document.querySelector('.arrival');if(!arrival)return;
 let seen=false;
 try{seen=sessionStorage.getItem('darkpool-arrived')==='1';sessionStorage.setItem('darkpool-arrived','1')}catch{}
 let internal=false;
 try{internal=!!document.referrer&&new URL(document.referrer).origin===location.origin}catch{}
 const navigation=performance.getEntriesByType('navigation')[0]?.type;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
 if(seen||internal||navigation==='reload'||navigation==='back_forward'||reduced){arrival.remove();return;}
 arrival.hidden=false;
 document.body.classList.add('arrival-pending');
 const started=performance.now();let leaving=false;
 const remove=()=>{document.body.classList.remove('arrival-pending');arrival.remove()};
 const leave=()=>{
  if(leaving)return;leaving=true;
  setTimeout(()=>{
   document.body.classList.remove('arrival-pending');arrival.classList.add('arrival-ready');
   setTimeout(remove,850);
  },Math.max(0,1450-(performance.now()-started)));
 };
 const logo=arrival.querySelector('img');
 Promise.allSettled([document.fonts.ready,logo?.decode?.()]).then(leave);
 setTimeout(leave,2200);
 // Always release heading animations, including if another script fails.
 setTimeout(remove,4000);
 window.addEventListener('pageshow',e=>{if(e.persisted)remove()});
})();
