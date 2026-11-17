/* BreakBench v3 team adapter: shared Supabase backend with allowlisted Auth accounts. */
(() => {
'use strict';
const PROJECT_URL = 'https://avgqxqcbphlqjbcjxqjf.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_UZAJd48Bq2TxvU-HoUgbUw_KGT_xrMk';
const root = document.getElementById('cloudGate');
const status = document.getElementById('cloudStatus');
const $c = id => document.getElementById(id);
let client, memberUser = null, rows = new Map(), writing = false, dirty = false, timer = null, remoteTimer = null, channel = null;
const stable = v => JSON.stringify(v);
function show(message, detail='') { $c('gateMessage').textContent=message; $c('gateDetail').textContent=detail; root.hidden=false; }
function logStatus(s) { status.textContent=s; }
function onError(error){ logStatus('Sync issue'); show('Cloud connection issue', (error && error.message) || String(error)); $c('cloudAuthForm').hidden=false; }
function makeRows() {
 const map = new Map();
 map.set('settings',{id:'settings',kind:'settings',payload:clone(state.settings)});
 map.set('draft',{id:'draft',kind:'draft',payload:clone(state.draft)});
 map.set('selection',{id:'selection',kind:'selection',payload:clone(state.selected)});
 for(const item of state.library)map.set('checklist:'+item.id,{id:'checklist:'+item.id,kind:'checklist',payload:clone(item)});
 for(const item of state.saved)map.set('price:'+item.id,{id:'price:'+item.id,kind:'price',payload:clone(item)});
 return map;
}
function hydrate(list){
 const remote=new Map(list.map(row=>[row.id,row]));
 const fresh=defaults();
 for(const row of list){
  if(row.id==='settings' && row.kind==='settings')fresh.settings=row.payload;
  if(row.id==='draft' && row.kind==='draft')fresh.draft=row.payload;
  if(row.id==='selection' && row.kind==='selection')fresh.selected=row.payload;
  if(row.kind==='checklist' && row.payload?.id)fresh.library.push(row.payload);
  if(row.kind==='price' && row.payload?.id)fresh.saved.push(row.payload);
 }
 fresh.library.sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));
 fresh.saved.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
 state=fresh;
 rows=remote;
 try{localStorage.setItem(KEY,JSON.stringify(state))}catch{}
 render();
}
async function reloadCloud(){
 if(!memberUser)return;
 const {data,error}=await client.from('breakbench_items').select('id,kind,payload,updated_at,updated_by');
 if(error)throw error;
 hydrate(data||[]);
 logStatus('● Live · '+memberUser.email);
}
// Override legacy local-only autosave. Reads/writes now go through a secure shared database.
persist = function(){
 if(!memberUser)return;
 dirty=true; logStatus('Saving…');
 clearTimeout(timer);timer=setTimeout(flushCloud,550);
};
async function flushCloud(){
 if(!memberUser||writing)return;
 if(!dirty)return;
 writing=true; dirty=false;
 const desired=makeRows();
 const upserts=[];const removals=[];
 for(const [id,record] of desired){
   const previous=rows.get(id);
   if(!previous||previous.kind!==record.kind||stable(previous.payload)!==stable(record.payload))
    upserts.push({...record,updated_by:memberUser.id,updated_at:new Date().toISOString()});
 }
 for(const id of rows.keys()) if(!desired.has(id))removals.push(id);
 try{
  if(upserts.length){
   const {error}=await client.from('breakbench_items').upsert(upserts,{onConflict:'id'});
   if(error)throw error;
  }
  if(removals.length){
   const {error}=await client.from('breakbench_items').delete().in('id',removals);
   if(error)throw error;
  }
  for(const record of upserts)rows.set(record.id,record);
  for(const id of removals)rows.delete(id);
  try{localStorage.setItem(KEY,JSON.stringify(state))}catch{}
  logStatus('✓ Saved · '+memberUser.email);
 }catch(err){
  dirty=true;
  logStatus('⚠ Unsaved changes');
  toast('Cloud save failed: '+err.message);
 }finally{
  writing=false;
  if(dirty){clearTimeout(timer);timer=setTimeout(flushCloud,1400)}
  else if(remoteTimer){clearTimeout(remoteTimer);remoteTimer=setTimeout(remoteRefresh,900)}
 }
}
async function remoteRefresh(){
 remoteTimer=null;
 if(writing||dirty){remoteTimer=setTimeout(remoteRefresh,1200);return}
 // Avoid replacing an input while a teammate is actively typing.
 if(document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !root.contains(document.activeElement)){
   remoteTimer=setTimeout(remoteRefresh,1500);return;
 }
 try{await reloadCloud()}catch(e){logStatus('Live sync paused');toast('Could not refresh: '+e.message)}
}
function subscribe(){
 if(channel)client.removeChannel(channel);
 channel=client.channel('breakbench-items-live')
  .on('postgres_changes',{event:'*',schema:'public',table:'breakbench_items'},()=>{
   clearTimeout(remoteTimer);remoteTimer=setTimeout(remoteRefresh,550);
  }).subscribe(status=>{
   if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')logStatus('Connected · realtime reconnecting');
  });
}
async function sessionChanged(session){
 if(!session){memberUser=null;root.hidden=false;$c('cloudAuthForm').hidden=false;show('Sign in to BreakBench','Only approved team members can access shared data.');logStatus('Sign in required');if(channel){client.removeChannel(channel);channel=null}return}
 const user=session.user;
 const {data,error}=await client.from('breakbench_team_members').select('user_id').eq('user_id',user.id).maybeSingle();
 if(error){onError(error);return}
 if(!data){memberUser=null;show('Account created — awaiting approval','Your email: '+user.email+'. A project owner must add this account to the team using the included SQL instructions. Then tap Check access.');$c('cloudAuthForm').hidden=true;$c('checkAccess').hidden=false;logStatus('Awaiting team approval');return}
 memberUser=user;
 try{await reloadCloud();subscribe();root.hidden=true;$c('checkAccess').hidden=true;}
 catch(e){onError(e)}
}
async function init(){
 if(!window.supabase?.createClient){show('Supabase library did not load','Connect to the internet and reload this page in Safari.');logStatus('Offline');return}
 client=window.supabase.createClient(PROJECT_URL,PUBLISHABLE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
 $c('cloudAuthForm').onsubmit=async e=>{
  e.preventDefault();
  const email=$c('cloudEmail').value.trim(),password=$c('cloudPassword').value;
  $c('cloudSubmit').disabled=true;
  logStatus('Signing in…');
  const {error}=await client.auth.signInWithPassword({email,password});
  $c('cloudSubmit').disabled=false;
  if(error)show('Could not sign in',error.message);
 };
 $c('cloudSignup').onclick=async()=>{
  const email=$c('cloudEmail').value.trim(),password=$c('cloudPassword').value;
  if(!email||password.length<6)return show('Enter your email and password','Use at least 6 characters for the password.');
  const {error}=await client.auth.signUp({email,password});
  if(error)show('Sign-up issue',error.message);
  else show('Check your email','Confirm your email if Supabase requires it, then sign in. The project owner must approve your account before you can see shared data.');
 };
 $c('cloudSignout').onclick=async()=>{memberUser=null;await client.auth.signOut();};
 $c('teamSignout').onclick=async()=>{if(!confirm('Sign out of BreakBench on this device?'))return;await flushCloud();memberUser=null;await client.auth.signOut();};
 $c('checkAccess').onclick=async()=>{const {data}=await client.auth.getSession();await sessionChanged(data.session)};
 client.auth.onAuthStateChange((_event,session)=>{setTimeout(()=>sessionChanged(session),0)});
 const {data,error}=await client.auth.getSession();if(error)show('Sign-in issue',error.message);else await sessionChanged(data.session);
}
init();
})();
