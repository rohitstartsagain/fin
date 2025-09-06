// === CONFIG: fill these two ===

const SUPABASE_URL  = "https://rfwklnklxasgbhzyjchu.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmd2tsbmtseGFzZ2JoenlqY2h1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcwNjQ2ODAsImV4cCI6MjA3MjY0MDY4MH0.CgsiLkKMq9cNpIXk-ThdDpo5WwNUWq-sjUq1f6QFuXU";
// ===============================
console.log("hippocampus app.js loaded");

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// --- UI helpers ---
const chatEl = document.getElementById('chat');
function addMsg(text, who='bot'){
  const div=document.createElement('div');
  div.className='row';
  const b=document.createElement('div');
  b.className=`msg ${who==='user'?'user':'bot'}`;
  b.textContent=text;
  if(who==='user') div.style.justifyContent='flex-end';
  div.appendChild(b); chatEl.appendChild(div);
  chatEl.scrollTop=chatEl.scrollHeight;
}

// --- Supabase helpers ---
async function householdId(){
  const {data,error}=await sb.from('households').select('id').eq('name','home-001').single();
  if(error) throw error; return data.id;
}
async function memberId(name){
  const {data}=await sb.from('members').select('id').eq('display_name',name).maybeSingle();
  if(data?.id) return data.id;
  const {data:ins,error}=await sb.from('members').insert({household_id:await householdId(),display_name:name}).select().single();
  if(error) throw error; return ins.id;
}

// --- Parsers ---
function parseExpense(text){
  const amt=text.replace(/,/g,'').match(/(?:₹|\$)?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if(!amt) return null;
  const amount=parseFloat(amt[1]);
  const lc=text.toLowerCase();
  const map=[['grocer','Groceries'],['food','Food & Dining'],['dinner','Food & Dining'],['lunch','Food & Dining'],['breakfast','Food & Dining'],
             ['fuel','Fuel'],['petrol','Fuel'],['diesel','Fuel'],['uber','Transport'],['ola','Transport'],['cab','Transport'],['bus','Transport'],['train','Transport'],['metro','Transport'],
             ['rent','Rent'],['bill','Bills & Utilities'],['electric','Bills & Utilities'],['internet','Bills & Utilities'],
             ['amazon','Shopping'],['myntra','Shopping'],['shopping','Shopping'],
             ['movie','Entertainment'],['entertain','Entertainment'],['netflix','Entertainment'],['spotify','Entertainment'],
             ['doctor','Health'],['pharma','Health'],['medicine','Health']];
  let category='Other'; for(const [k,c] of map) if(lc.includes(k)){category=c;break;}
  const d=new Date(); if(lc.includes('yesterday')) d.setDate(d.getDate()-1);
  return {amount, category, expense_date:d.toISOString().slice(0,10), currency: lc.includes('$')?'USD':'INR'};
}
function monthRange(dt=new Date()){
  const start=new Date(dt.getFullYear(),dt.getMonth(),1);
  const end=new Date(dt.getFullYear(),dt.getMonth()+1,1);
  return [start.toISOString().slice(0,10), end.toISOString().slice(0,10)];
}
function parseQuery(text, memberName){
  const lc=text.toLowerCase();
  const cats=['Groceries','Food & Dining','Fuel','Transport','Rent','Bills & Utilities','Shopping','Entertainment','Health','Other'];
  let category=null; for(const c of cats) if(lc.includes(c.toLowerCase())){category=c;break;}
  const today=new Date(); let [start,end]=monthRange(today);
  if(lc.includes('last month')) [start,end]=monthRange(new Date(today.getFullYear(),today.getMonth()-1,1));
  if(lc.includes('last week')||lc.includes('past week')){end=new Date(today);end.setHours(0,0,0,0);const s=new Date(end);s.setDate(end.getDate()-7);start=s.toISOString().slice(0,10);end=end.toISOString().slice(0,10);} 
  const scope=(lc.includes('together')||lc.includes('we '))?'household':'me';
  return {start,end,category,scope,memberName};
}

// --- Wiring ---
const input=document.getElementById('input');
const memberSel=document.getElementById('member');
document.getElementById('send').addEventListener('click', onSend);
input.addEventListener('keydown',(e)=>{if(e.key==='Enter') onSend();});
document.getElementById('csv').addEventListener('click', downloadCSV);
document.getElementById('seed').addEventListener('click', seedDemo);
document.getElementById('upload').addEventListener('click', handleUpload);
updateTotals(); // initial
addMsg("Hi! Log an expense like “Spent ₹350 on groceries” or ask “How much did I spend last month on entertainment?”");

async function onSend(){
  const text=input.value.trim(); if(!text) return;
  const memberName=memberSel.value; addMsg(text,'user'); input.value='';
  try{
    const hh=await householdId(); const mid=await memberId(memberName);
    await sb.from('messages').insert({household_id:hh, member_id:mid, role:'user', content:text});
    const exp=parseExpense(text);
    if(exp && /spent|paid|bought|purchase|₹|\$/.test(text.toLowerCase())){
      const {error}=await sb.from('expenses').insert({...exp, household_id:hh, member_id:mid, description:text, source:'text', raw_text:text});
      if(error) throw error;
      addMsg(`Logged: ${exp.currency} ${exp.amount.toFixed(2)} · ${exp.category} · ${exp.expense_date}`);
      await updateTotals();
      return;
    }
    const q=parseQuery(text, memberName);
    let query=sb.from('expenses').select('amount,category,expense_date,member_id').gte('expense_date',q.start).lt('expense_date',q.end);
    if(q.category) query=query.eq('category',q.category);
    if(q.scope==='me') query=query.eq('member_id', await memberId(memberName));
    const {data,error}=await query; if(error) throw error;
    const total=(data||[]).reduce((s,r)=>s+Number(r.amount||0),0);
    const who=q.scope==='me'?memberName:'household'; const cat=q.category?` on ${q.category}`:'';
    addMsg(`Total ${who}${cat}: ₹${total.toFixed(2)} for ${q.start} → ${q.end} (${(data||[]).length} txns).`);
  }catch(e){console.error(e); addMsg("Oops, something went wrong. Open Console.");}
}

async function updateTotals(){
  const [start,end]=monthRange();
  async function sum(filter){
    let q=sb.from('expenses').select('amount').gte('expense_date',start).lt('expense_date',end);
    if(filter) q=q.eq(...filter);
    const {data}=await q; return (data||[]).reduce((s,r)=>s+Number(r.amount||0),0);
  }
  const p1=await memberId('Partner 1'); const p2=await memberId('Partner 2');
  const meId=await memberId(memberSel.value);
  const [meTot,p1Tot,p2Tot,hhTot]=await Promise.all([
    sum(['member_id',meId]), sum(['member_id',p1]), sum(['member_id',p2]), sum()
  ]);
  document.getElementById('tot-me').textContent=`Your month: ₹${meTot.toFixed(0)}`;
  document.getElementById('tot-p1').textContent=`Partner 1: ₹${p1Tot.toFixed(0)}`;
  document.getElementById('tot-p2').textContent=`Partner 2: ₹${p2Tot.toFixed(0)}`;
  document.getElementById('tot-hh').textContent=`Household: ₹${hhTot.toFixed(0)}`;
}

async function downloadCSV(){
  const [start,end]=monthRange();
  const {data,error}=await sb.from('expenses').select('expense_date,amount,currency,category,description').gte('expense_date',start).lt('expense_date',end).order('expense_date',{ascending:true});
  if(error){alert('CSV error');return;}
  const rows=[['date','amount','currency','category','description'],...data.map(r=>[r.expense_date,r.amount,r.currency,r.category,(r.description||'').replace(/\n/g,' ')])];
  const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  const a=document.createElement('a'); a.href=url; a.download='expenses-month.csv'; a.click(); URL.revokeObjectURL(url);
}

async function seedDemo(e){
  e.target.disabled=true;
  const hh=await householdId(); const p1=await memberId('Partner 1'); const p2=await memberId('Partner 2');
  const today=new Date(); const d=(n)=>{const x=new Date(today); x.setDate(x.getDate()-n); return x.toISOString().slice(0,10);};
  await sb.from('expenses').insert([
    {household_id:hh,member_id:p1,expense_date:d(1),amount:350,currency:'INR',category:'Groceries',description:'Ratnadeep groceries',source:'text'},
    {household_id:hh,member_id:p1,expense_date:d(2),amount:1200,currency:'INR',category:'Fuel',description:'Fuel',source:'text'},
    {household_id:hh,member_id:p2,expense_date:d(5),amount:999,currency:'INR',category:'Entertainment',description:'Netflix annual',source:'text'},
    {household_id:hh,member_id:p2,expense_date:d(3),amount:450,currency:'INR',category:'Food & Dining',description:'Lunch',source:'text'}
  ]);
  addMsg("Seeded 4 demo expenses."); await updateTotals();
}

async function handleUpload() {
  // 1) Pick a file
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.click();
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    // 2) Convert to base64 (no headers, just the data)
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });

    addMsg("Reading screenshot…");
    try {
      // 3) Call your Netlify function
      const memberName = document.getElementById('member').value;
      const resp = await fetch('/.netlify/functions/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, memberName })
      });

      // PARSE SAFELY
      const raw = await resp.text();
      let data = null;
      try { data = JSON.parse(raw); } catch { /* leave null */ }

      if (!resp.ok) {
        addMsg(`OCR error: ${raw || 'unknown'}`);
        return;
      }

      // use parsed JSON
      const parsed = data || {};

      // 4) Insert into Supabase using existing schema
      const hh = await householdId();
      const mid = await memberId(memberName);
      const { amount, expense_date, category, description, currency = 'INR' } = parsed;

      const { error } = await sb.from('expenses').insert({
        household_id: hh,
        member_id: mid,
        expense_date,
        amount,
        currency,
        category,
        description,
        source: 'image',
        raw_text: 'OCR import'
      });
      if (error) throw error;

      addMsg(`Logged from screenshot: ₹${Number(amount || 0).toFixed(2)} · ${category} · ${expense_date}`);
      await updateTotals();
    } catch (e) {
      console.error(e);
      addMsg("Upload failed. Check Console.");
    }
  };
}


