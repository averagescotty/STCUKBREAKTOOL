/* BreakBench v3.4 team adapter: shared Supabase backend with allowlisted Auth accounts. */
(() => {
'use strict';
const PROJECT_URL = 'https://avgqxqcbphlqjbcjxqjf.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_UZAJd48Bq2TxvU-HoUgbUw_KGT_xrMk';
const root = document.getElementById('cloudGate');
const status = document.getElementById('cloudStatus');
const $c = id => document.getElementById(id);
let client, memberUser = null, rows = new Map(), writing = false, dirty = false, timer = null, remoteTimer = null, channel = null;
const stable = v => JSON.stringify(v);
const UNSENT_KEY='breakbench.unsent.v1';
let inFlightRefresh=false;
function saveLocalImmediately(){
 try{localStorage.setItem(KEY,JSON.stringify(state));localStorage.setItem(UNSENT_KEY,'1')}catch{}
}
function hasUnsaved(){try{return localStorage.getItem(UNSENT_KEY)==='1'}catch{return false}}
function clearUnsaved(){try{localStorage.removeItem(UNSENT_KEY)}catch{}}
// Browser tab changes may interrupt timers; queue a cloud write before suspension.
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&dirty){clearTimeout(timer);void flushCloud()}});
window.addEventListener('pagehide',()=>{if(dirty){clearTimeout(timer);void flushCloud()}});
// Capture the link type before Supabase removes auth tokens from the URL.
const incomingParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
const incomingType = incomingParams.get('type') || new URLSearchParams(window.location.search).get('type');
let passwordSetupMode = incomingType === 'recovery' || incomingType === 'invite';
let passwordSetupReady = false;
let sessionCheckSerial = 0;
// Supabase may leave #type=recovery (and token fragments) in the page URL.
// Remove *only after* the callback has been processed and password updated;
// otherwise a later login or page reload can reopen the password setup screen.
function clearAuthCallbackUrl(){
 try {
  const url = new URL(window.location.href);
  const authParams = ['type','code','token','token_hash','access_token','refresh_token',
    'expires_at','expires_in','provider_token','provider_refresh_token','error',
    'error_code','error_description'];
  for (const name of authParams) url.searchParams.delete(name);
  const hashText = url.hash.replace(/^#/, '');
  if (hashText && (authParams.some(name => new URLSearchParams(hashText).has(name)))) {
    url.hash = '';
  }
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
 } catch (e) { /* Password update is more important than URL tidying. */ }
}
function finishPasswordSetup(){
 passwordSetupMode=false;
 passwordSetupReady=false;
 ++sessionCheckSerial; // Invalidate any delayed check from the recovery session.
 clearAuthCallbackUrl();
}

function authView(mode, message, detail='') {
  show(message,detail);
  $c('cloudAuthForm').hidden = mode !== 'login';
  $c('cloudForgotForm').hidden = mode !== 'forgot';
  $c('cloudResetForm').hidden = mode !== 'reset';
  $c('cloudSignup').hidden = mode !== 'login';
  $c('cloudForgot').hidden = mode !== 'login';
  $c('cloudBack').hidden = mode !== 'forgot';
  $c('checkAccess').hidden = true;
  $c('cloudSignout').hidden = mode !== 'login';
}
function openPasswordSetup(){
 passwordSetupMode=true;passwordSetupReady=true;
 authView('reset','Set your BreakBench password','Enter and confirm a new password for your existing account.');
 logStatus('Password setup required');
}
function appRedirectUrl(){return window.location.origin + window.location.pathname;}

function show(message, detail='') { $c('gateMessage').textContent=message; $c('gateDetail').textContent=detail; root.hidden=false; }
function logStatus(s) { status.textContent=s; }
function onError(error){ logStatus('Sync issue'); authView('login','Cloud connection issue', (error && error.message) || String(error)); }
function makeRows() {
 const map = new Map();
 map.set('settings',{id:'settings',kind:'settings',payload:clone(state.settings)});
 for (const draft of state.drafts||[]) map.set('draft:'+draft.id,{id:'draft:'+draft.id,kind:'draft',payload:clone(draft)});
 for(const item of state.library)map.set('checklist:'+item.id,{id:'checklist:'+item.id,kind:'checklist',payload:clone(item)});
 for(const item of state.saved)map.set('price:'+item.id,{id:'price:'+item.id,kind:'price',payload:clone(item)});
 return map;
}
function hydrate(list){
 const remote=new Map(list.map(row=>[row.id,row]));
 const fresh=defaults();fresh.drafts=[];
 let legacy=null,legacySelection=[];
 for(const row of list){
  if(row.id==='settings' && row.kind==='settings')fresh.settings=row.payload;
  if(row.id==='draft' && row.kind==='draft')legacy=row.payload;
  if(row.id==='selection' && row.kind==='selection' && Array.isArray(row.payload))legacySelection=row.payload;
  if(row.id.startsWith('draft:') && row.kind==='draft' && row.payload)fresh.drafts.push(row.payload);
  if(row.kind==='checklist' && row.payload?.id)fresh.library.push(row.payload);
  if(row.kind==='price' && row.payload?.id)fresh.saved.push(row.payload);
 }
 if(!fresh.drafts.length && legacy){legacy=clone(legacy);legacy.id=legacy.id||uid();legacy.checklistIds=Array.isArray(legacy.checklistIds)?legacy.checklistIds:legacySelection;fresh.drafts=[legacy]}
 if(!fresh.drafts.length)fresh.drafts=[emptyDraft()];
 fresh.library.sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));
 fresh.saved.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
 state=fresh;rows=remote;
 ensureDrafts();
 try{localStorage.setItem(KEY,JSON.stringify(state))}catch{}
 render();
}
async function reloadCloud(){
 if(!memberUser||dirty||writing||inFlightRefresh)return;
 inFlightRefresh=true;
 try{
 const {data,error}=await client.from('breakbench_items').select('id,kind,payload,updated_at,updated_by');
 if(error)throw error;
 if(dirty||writing)return;
 hydrate(data||[]);
 logStatus('● Live · '+memberUser.email);
 }finally{inFlightRefresh=false}
}
// Override legacy autosave. Cache edits locally immediately and queue shared cloud writes.
persist = function(){
 saveLocalImmediately();
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
  if(!dirty)clearUnsaved();
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
 if(writing||dirty||inFlightRefresh){remoteTimer=setTimeout(remoteRefresh,1200);return}
 if(document.visibilityState==='hidden'){remoteTimer=setTimeout(remoteRefresh,1500);return}
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
 const callId=++sessionCheckSerial;
 if(passwordSetupMode){
   if(session) {openPasswordSetup();return}
   if(passwordSetupReady) return;
   passwordSetupMode=false;
   authView('login','Could not open the password link','The link may be invalid or expired. Tap Forgot password to request a new email.');
   logStatus('Sign in required');
   return;
 }
 if(!session){memberUser=null;authView('login','Sign in to BreakBench','Only approved team members can access shared data.');logStatus('Sign in required');if(channel){client.removeChannel(channel);channel=null}return}
 const user=session.user;
 // TOKEN_REFRESHED / focus revalidation should not re-hydrate the shared draft
 // while the same team member is editing it in this tab.
 if(memberUser?.id===user.id && !root.hidden){root.hidden=true;return}
 if(memberUser?.id===user.id && root.hidden)return;
 const {data,error}=await client.from('breakbench_team_members').select('user_id').eq('user_id',user.id).maybeSingle();
 if(callId!==sessionCheckSerial)return;
 if(error){onError(error);return}
 if(!data){memberUser=null;authView('login','Account awaiting approval','Your email: '+user.email+'. A project owner must add this account to the team, then tap Check access.');$c('cloudAuthForm').hidden=true;$c('checkAccess').hidden=false;logStatus('Awaiting team approval');return}
 memberUser=user;
 // If a previous tab suspension left unsent changes, send them before a reload.
 if(hasUnsaved()){dirty=true;await flushCloud()}
 try{await reloadCloud();if(callId!==sessionCheckSerial)return;subscribe();root.hidden=true;$c('checkAccess').hidden=true;}
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
  if(error)authView('login','Could not sign in',error.message + ' If you joined using an email invitation, use Forgot password to set a new password.');
 };
 $c('cloudSignup').onclick=async()=>{
  const email=$c('cloudEmail').value.trim(),password=$c('cloudPassword').value;
  if(!email||password.length<6)return show('Enter your email and password','Use at least 6 characters for the password.');
  const {error}=await client.auth.signUp({email,password});
  if(error)authView('login','Sign-up issue',error.message);
  else authView('login','Check your email','If this email already has an account, use Forgot password instead of Create account. Your project owner must approve your access.');
 };
 $c('cloudForgot').onclick=()=>{
  $c('cloudRecoveryEmail').value=$c('cloudEmail').value.trim();
  authView('forgot','Reset your password','Enter the email linked to your existing BreakBench account.');
 };
 $c('cloudBack').onclick=()=>authView('login','Sign in to BreakBench','Enter your email and password.');
 $c('cloudForgotForm').onsubmit=async e=>{
  e.preventDefault();
  const email=$c('cloudRecoveryEmail').value.trim();
  const submit=$c('cloudSendRecovery');submit.disabled=true;
  try{
   const {error}=await client.auth.resetPasswordForEmail(email,{redirectTo:appRedirectUrl()});
   if(error)throw error;
   authView('login','Check your email','If that address has an account, Supabase will send a reset link. Open the newest email on this iPad, then choose your new password. Check spam too.');
   $c('cloudEmail').value=email;
  }catch(error){authView('forgot','Could not request a reset',error.message);}
  finally{submit.disabled=false}
 };
 $c('cloudResetForm').onsubmit=async e=>{
  e.preventDefault();
  const pass=$c('cloudNewPassword').value,confirmPass=$c('cloudConfirmPassword').value;
  if(pass.length<8)return authView('reset','Choose a longer password','Use at least 8 characters.');
  if(pass!==confirmPass)return authView('reset','Passwords do not match','Enter the same password in both boxes.');
  const submit=$c('cloudSetPassword');submit.disabled=true;
  try{
   const {data:sessionData}=await client.auth.getSession();
   if(!sessionData.session)throw new Error('The reset link is missing or expired. Request a new email from Forgot password.');
   const {error}=await client.auth.updateUser({password:pass});
   if(error)throw error;
   finishPasswordSetup();
   $c('cloudNewPassword').value='';$c('cloudConfirmPassword').value='';
   // An explicit fresh sign-in avoids relying on the temporary recovery session.
   await client.auth.signOut();
   memberUser=null;
   authView('login','Password saved successfully','You can now sign in with your existing email and new password.');
   logStatus('Password set · sign in');
  }catch(error){authView('reset','Could not set password',error.message);}
  finally{submit.disabled=false}
 };
 $c('cloudSignout').onclick=async()=>{finishPasswordSetup();memberUser=null;await client.auth.signOut();};
 $c('teamSignout').onclick=async()=>{if(!confirm('Sign out of BreakBench on this device?'))return;await flushCloud();finishPasswordSetup();memberUser=null;await client.auth.signOut();};
 $c('checkAccess').onclick=async()=>{const {data}=await client.auth.getSession();await sessionChanged(data.session)};
 client.auth.onAuthStateChange((event,session)=>{
  if(event==='PASSWORD_RECOVERY'){passwordSetupMode=true;passwordSetupReady=true;}
  // Never schedule an unconditional reset view: the user may have just
  // completed the reset while a SIGNED_IN/USER_UPDATED callback was queued.
  setTimeout(()=>sessionChanged(session),0);
 });
 const {data,error}=await client.auth.getSession();if(error)authView('login','Sign-in issue',error.message);else await sessionChanged(data.session);
}
init();
})();
