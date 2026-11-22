// Local presentation preferences only; never stored with a campaign or access credential.
export function normalizeReadability(value={}) {
  return {scale:[100,125,150].includes(value?.scale)?value.scale:100,reducedMotion:value?.reducedMotion===true};
}
export function setupReadability(doc=document,storage) {
  const key='dicerealm.display.v1';let value;
  try{storage??=globalThis.localStorage;value=normalizeReadability(JSON.parse(storage.getItem(key)));}catch{value=normalizeReadability();}
  const size=doc.getElementById('text-size'),motion=doc.getElementById('reduce-motion');
  function apply(save=false){
    doc.documentElement.dataset.uiScale=String(value.scale);
    doc.documentElement.dataset.reduceMotion=String(value.reducedMotion);
    size.value=String(value.scale);
    motion.checked=value.reducedMotion;
    if(save)try{storage.setItem(key,JSON.stringify(value));}catch{/* Preferences must not block the UI. */}
  }
  size.onchange=()=>{value=normalizeReadability({...value,scale:Number(size.value)});apply(true);};
  motion.onchange=()=>{value.reducedMotion=motion.checked;apply(true);};
  apply();
}
