export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GrokBotTrack</title>
<style>
:root{
  --surface-0:#f4f4f1; --surface-1:#fcfcfb; --border:#e4e3de;
  --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#8a8983;
  --blue:#2a78d6; --aqua:#1baf7a; --yellow:#c98500; --red:#e34948; --violet:#4a3aa7;
  --shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);
}
@media (prefers-color-scheme:dark){:root{
  --surface-0:#111110; --surface-1:#1a1a19; --border:#33322f;
  --text-primary:#fff; --text-secondary:#c3c2b7; --text-muted:#8f8e86;
  --blue:#3987e5; --aqua:#199e70; --yellow:#eda100; --red:#e66767; --violet:#9085e9;
  --shadow:0 1px 3px rgba(0,0,0,.4);
}}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:var(--surface-0);color:var(--text-primary);-webkit-font-smoothing:antialiased}
header{padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:baseline;gap:12px}
header h1{margin:0;font-size:18px;font-weight:650;letter-spacing:-.01em}
header .who{color:var(--text-secondary);font-size:14px}
main{max-width:1100px;margin:0 auto;padding:24px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.tile{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow)}
.tile .n{font-size:28px;font-weight:680;letter-spacing:-.02em}
.tile .l{font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
table{width:100%;border-collapse:collapse;background:var(--surface-1);border:1px solid var(--border);
  border-radius:12px;overflow:hidden;box-shadow:var(--shadow)}
th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);
  font-weight:600;padding:10px 16px;border-bottom:1px solid var(--border)}
td{padding:11px 16px;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:none}
.rcpt{font-weight:600}.sub{color:var(--text-secondary);font-size:13px}
.pill{display:inline-block;min-width:22px;text-align:center;padding:2px 8px;border-radius:20px;font-size:13px;font-weight:600}
.pill.open{background:color-mix(in srgb,var(--blue) 15%,transparent);color:var(--blue)}
.pill.click{background:color-mix(in srgb,var(--aqua) 18%,transparent);color:var(--aqua)}
.pill.zero{background:transparent;color:var(--text-muted);font-weight:500}
.when{color:var(--text-secondary);font-size:13px;white-space:nowrap}
.expand{cursor:pointer;user-select:none}
.expand:hover{background:color-mix(in srgb,var(--text-primary) 3%,transparent)}
.chev{display:inline-block;width:14px;color:var(--text-muted);transition:transform .15s}
.open-row .chev{transform:rotate(90deg)}
.timeline{padding:4px 16px 14px 40px;font-size:13px}
.ev{display:flex;gap:10px;align-items:center;padding:5px 0;border-bottom:1px dashed var(--border)}
.ev:last-child{border-bottom:none}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot.open{background:var(--blue)}.dot.click{background:var(--aqua)}
.ev .t{color:var(--text-secondary);min-width:150px}
.ev .loc{color:var(--text-muted)}
.tag{font-size:11px;padding:1px 6px;border-radius:5px;background:color-mix(in srgb,var(--text-primary) 6%,transparent);color:var(--text-muted)}
.tag.human{background:color-mix(in srgb,var(--aqua) 15%,transparent);color:var(--aqua)}
.tag.scanner,.tag.apple-prefetch{background:color-mix(in srgb,var(--yellow) 18%,transparent);color:var(--yellow)}
.gate{max-width:380px;margin:80px auto;text-align:center}
.gate input{width:100%;padding:11px 14px;border:1px solid var(--border);border-radius:10px;
  background:var(--surface-1);color:var(--text-primary);font-size:14px;margin:12px 0}
.gate button{width:100%;padding:11px;border:none;border-radius:10px;background:var(--blue);color:#fff;
  font-size:14px;font-weight:600;cursor:pointer}
.muted{color:var(--text-muted)}.empty{padding:40px;text-align:center;color:var(--text-muted)}
.linkurl{color:var(--text-secondary);word-break:break-all}
</style>
</head>
<body>
<div id="root"></div>
<script>
const $=s=>document.querySelector(s);
const qs=new URLSearchParams(location.search);
let token=qs.get('token')||sessionStorage.getItem('dt_token')||'';
if(qs.get('token')){sessionStorage.setItem('dt_token',token);history.replaceState({},'',location.pathname);}

const fmt=ts=>{const d=new Date(ts);return d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});};
const loc=e=>[e.city,e.region,e.country].filter(Boolean).join(', ');
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Session cookie (set by a magic link) is sent automatically; the Bearer header
// is only added when someone pasted a personal dt_ token.
async function api(path){
  const h=token?{Authorization:'Bearer '+token}:{};
  const r=await fetch(path,{headers:h,credentials:'same-origin'});
  if(!r.ok)throw new Error(r.status);return r.json();
}

function gate(msg){
  const err=new URLSearchParams(location.search).get('err');
  const note=err==='expired'?'That link expired or was already used. Request a new one.':
             err==='invalid'?'That link was not valid. Request a new one.':(msg||'');
  $('#root').innerHTML='<div class="gate"><h1>GrokBotTrack</h1>'+
    (note?'<p class="muted">'+esc(note)+'</p>':'<p class="muted">Sign in to see your tracked emails</p>')+
    '<input id="email" type="email" placeholder="you@yourdomain.com" autofocus>'+
    '<button onclick="sendLink()">Email me a sign-in link</button>'+
    '<p id="sent" class="muted" style="display:none;margin-top:14px">'+
    'If that address has an account, a sign-in link is on its way. It expires in 15 minutes.</p>'+
    '<details style="margin-top:22px;text-align:left"><summary class="muted" style="cursor:pointer;font-size:13px">Use an API token instead</summary>'+
    '<input id="tok" placeholder="dt_..."><button onclick="setTok()">Open dashboard</button></details></div>';
}
window.sendLink=async()=>{
  const email=$('#email').value.trim();if(!email)return;
  try{
    const r=await fetch('/api/auth/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
    if(r.status===503){$('#sent').textContent='Magic-link login is not configured yet — use an API token below.';}
    $('#sent').style.display='';
  }catch(e){$('#sent').textContent='Could not send right now. Try the API token option.';$('#sent').style.display='';}
};
window.setTok=()=>{token=$('#tok').value.trim();sessionStorage.setItem('dt_token',token);load();};

function groupByRecipient(msgs){
  const m=new Map();
  for(const x of msgs){
    if(!m.has(x.recipient))m.set(x.recipient,{recipient:x.recipient,opens:0,clicks:0,last:null,msgs:[]});
    const g=m.get(x.recipient);
    g.opens+=x.confirmed_opens||0;g.clicks+=x.clicks||0;g.msgs.push(x);
    if(x.last_human_activity&&(!g.last||x.last_human_activity>g.last))g.last=x.last_human_activity;
  }
  return [...m.values()].sort((a,b)=>(b.last||'').localeCompare(a.last||''));
}

async function load(){
  let data;
  try{data=await api('/api/summary');}catch(e){
    return gate(e.message==='401'?(token?'That token was not valid.':''):'Could not load. Try again.');
  }
  const msgs=data.messages||[];
  const groups=groupByRecipient(msgs);
  const tOpens=msgs.reduce((s,m)=>s+(m.confirmed_opens||0),0);
  const tClicks=msgs.reduce((s,m)=>s+(m.clicks||0),0);
  const openedCount=groups.filter(g=>g.opens>0).length;
  $('#root').innerHTML=
    '<header><h1>GrokBotTrack</h1><span class="who">'+esc(data.user.name)+'</span></header><main>'+
    '<div class="tiles">'+
      tile(msgs.length,'Emails sent')+tile(groups.length,'Recipients')+
      tile(openedCount,'Opened by')+tile(tOpens,'Confirmed opens')+tile(tClicks,'Clicks')+
    '</div>'+
    (groups.length?'<table><thead><tr><th>Recipient</th><th>Opens</th><th>Clicks</th><th>Last activity</th></tr></thead><tbody>'+
      groups.map(rowGroup).join('')+'</tbody></table>':'<div class="empty">No tracked emails yet. Register one via the API and it will appear here.</div>')+
    '</main>';
}
const tile=(n,l)=>'<div class="tile"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>';
function pill(n,cls){return '<span class="pill '+(n?cls:'zero')+'">'+n+'</span>';}

function rowGroup(g){
  const rows=g.msgs.map(m=>{
    return '<tr class="expand" onclick="toggle(this,\\''+m.id+'\\')"><td><span class="chev">›</span> <span class="sub">'+esc(m.subject||'(no subject)')+'</span>'+
      (m.campaign?' <span class="tag">'+esc(m.campaign)+'</span>':'')+'</td>'+
      '<td>'+pill(m.confirmed_opens,'open')+'</td><td>'+pill(m.clicks,'click')+'</td>'+
      '<td class="when">'+(m.last_human_activity?fmt(m.last_human_activity):'—')+'</td></tr>'+
      '<tr id="tl-'+m.id+'" style="display:none"><td colspan="4" style="padding:0"><div class="timeline muted">loading…</div></td></tr>';
  }).join('');
  return '<tr><td class="rcpt">'+esc(g.recipient)+'</td><td>'+pill(g.opens,'open')+'</td><td>'+pill(g.clicks,'click')+
    '</td><td class="when">'+(g.last?fmt(g.last):'—')+'</td></tr>'+rows;
}

window.toggle=async(row,id)=>{
  const tl=$('#tl-'+id);const shown=tl.style.display!=='none';
  tl.style.display=shown?'none':'';row.classList.toggle('open-row',!shown);
  if(shown)return;
  const box=tl.querySelector('.timeline');
  try{
    const {events}=await api('/api/messages/'+id+'/events');
    box.classList.remove('muted');
    box.innerHTML=events.length?events.map(e=>{
      const l=loc(e);const proxied=e.classification!=='human';
      return '<div class="ev"><span class="dot '+e.type+'"></span>'+
        '<span class="t">'+fmt(e.ts)+'</span>'+
        '<span>'+(e.type==='click'?'Clicked <span class="linkurl">'+esc(e.original_url||'')+'</span>':'Opened')+'</span>'+
        (l&&!proxied?'<span class="loc">'+esc(l)+'</span>':'')+
        '<span class="tag '+e.classification+'">'+e.classification+'</span></div>';
    }).join(''):'<span class="muted">No events yet.</span>';
  }catch(e){box.textContent='Error loading events.';}
};

// Try the session cookie first; load() falls back to the sign-in gate on 401.
load();
</script>
</body>
</html>`;
