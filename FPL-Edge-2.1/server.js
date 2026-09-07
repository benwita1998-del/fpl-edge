import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const TEAM_ID = process.env.FPL_TEAM_ID || '702959';
const API = 'https://fantasy.premierleague.com/api';
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify({ prices: {}, snapshots: [], recommendations: [] }, null, 2));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { prices: {}, snapshots: [], recommendations: [] }; } }
function writeState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
async function fpl(endpoint) {
  const r = await fetch(API + endpoint, { headers: { 'User-Agent': 'FPL-Edge/2.0' } });
  if (!r.ok) throw new Error(`FPL API ${r.status}: ${endpoint}`);
  return r.json();
}
function pos(p) { return ({ 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' })[p.element_type] || '?'; }
function enrich(b) {
  const teams = Object.fromEntries(b.teams.map(t => [t.id, t]));
  const players = Object.fromEntries(b.elements.map(p => [p.id, { ...p, team_id: p.team, team_name: teams[p.team]?.name || '', team_short: teams[p.team]?.short_name || '' }]));
  return { teams, players };
}
function fixturesFor(fixtures, p, teams, gw) {
  return fixtures.filter(f => f.event != null && f.event >= gw && (f.team_h === p.team_id || f.team_a === p.team_id)).map(f => {
    const home = f.team_h === p.team_id; const opp = teams[home ? f.team_a : f.team_h];
    return { event: f.event, opponent: opp?.short_name || 'TBC', home, fdr: home ? f.team_h_difficulty : f.team_a_difficulty, kickoff: f.kickoff_time };
  }).sort((a,b) => a.event-b.event);
}
function modelScore(p, next5) {
  const form = +p.form || 0, ppg = +p.points_per_game || 0, mins = +p.minutes || 0;
  const xgi = (+p.expected_goals || 0) + (+p.expected_assists || 0);
  const fixture = next5.length ? next5.reduce((s,f)=>s + (6-(+f.fdr||3)),0)/next5.length : 3;
  const availability = p.status === 'a' ? 1 : p.status === 'd' ? ((+p.chance_of_playing_next_round || 50)/100) : 0;
  return +(form*0.85 + ppg*0.5 + xgi*1.15 + fixture*1.05 + Math.min(1, mins/900)*1.4 + availability*1.5).toFixed(3);
}
function sellPrice(now, paid) {
  now = +now; paid = +paid;
  if (now <= paid) return +paid.toFixed(1);
  return +(paid + Math.floor(((now-paid)/2)*10 + 1e-9)/10).toFixed(1); // round retained gain down to nearest £0.1m
}
function clubCounts(squad) { const c={}; for (const x of squad) c[x.team_id]=(c[x.team_id]||0)+1; return c; }
function legalSquad(squad) {
  const counts=clubCounts(squad); if(Object.values(counts).some(x=>x>3)) return false;
  const by={1:0,2:0,3:0,4:0}; squad.forEach(p=>by[p.element_type]++);
  return squad.length===15 && by[1]===2 && by[2]===5 && by[3]===5 && by[4]===3;
}
function replayFT(history, targetGw, chips) {
  let banked = 0;
  const chipByGw = Object.fromEntries((chips||[]).map(c=>[c.event,c.name]));
  const rows = [...(history||[])].sort((a,b)=>a.event-b.event);
  for (const row of rows) {
    if (row.event >= targetGw) break;
    const received = Math.min(5, banked + 1);
    const chip = chipByGw[row.event];
    if (chip === 'wildcard' || chip === 'freehit') banked = banked; // the current week's new FT is consumed; saved FTs remain
    else banked = Math.max(0, received - (+row.event_transfers||0));
  }
  return Math.min(5, banked + 1);
}
function chipStatus(history) {
  const used = history.chips || [];
  const names = [['wildcard','Wildcard'],['freehit','Free Hit'],['bboost','Bench Boost'],['3xc','Triple Captain']];
  return names.flatMap(([key,label])=>[
    {key,label,half:1,used:used.find(x=>x.name===key && x.event<=19)||null},
    {key,label,half:2,used:used.find(x=>x.name===key && x.event>=20)||null}
  ]);
}

async function load() {
  const [b, entry, history, transfers] = await Promise.all([fpl('/bootstrap-static/'), fpl(`/entry/${TEAM_ID}/`), fpl(`/entry/${TEAM_ID}/history/`), fpl(`/entry/${TEAM_ID}/transfers/`)]);
  const {teams,players}=enrich(b);
  const current=b.events.find(e=>e.is_current)||b.events.find(e=>e.is_next)||b.events[0];
  const gw=current.id; let picks={picks:[]}; try { picks=await fpl(`/entry/${TEAM_ID}/event/${gw}/picks/`); } catch {}
  const fixtures=b.fixtures||[]; const state=readState();
  const transferMap=new Map((transfers||[]).map(t=>[t.element_in, +t.cost/10]));
  const squad=picks.picks.map(x=>({ ...x, player:players[x.element], purchase_price: x.selling_price!=null ? null : (transferMap.get(x.element) ?? (+players[x.element].now_cost/10)), current_selling_price: x.selling_price!=null ? (+x.selling_price/10) : null, next5:fixturesFor(fixtures,players[x.element],teams,gw).slice(0,5) }));
  const allPlayers=Object.values(players).map(p=>{
    const next5=fixturesFor(fixtures,p,teams,gw).slice(0,5); const price=+p.now_cost/10; const old=state.prices[p.id];
    return {id:p.id,name:p.web_name,team:p.team_name,team_short:p.team_short,position:pos(p),element_type:p.element_type,price,points:p.total_points,form:p.form,ppg:p.points_per_game,ownership:p.selected_by_percent,xg:p.expected_goals,xa:p.expected_assists,minutes:p.minutes,status:p.status,news:p.news,chance:p.chance_of_playing_this_round,next5,score:modelScore(p,next5),price_change:old==null?0:+(price-old).toFixed(1)};
  });
  for(const p of allPlayers) state.prices[p.id]=p.price;
  state.snapshots.push({at:new Date().toISOString(),gw,prices:Object.fromEntries(allPlayers.map(p=>[p.id,p.price]))});
  state.snapshots=state.snapshots.slice(-200);
  writeState(state);
  const currentHistory=(history.current||[]).at(-1)||{};
  const freeTransfers=replayFT(history.current||[],gw,history.chips||[]);
  return {b,entry,history,transfers,teams,players,fixtures,gw,picks,squad,allPlayers,freeTransfers,bank:(entry.last_deadline_bank||0)/10,state};
}

function rankXI(squad) {
  const starters=squad.filter(x=>x.multiplier>0).sort((a,b)=>b.player.model-b.player.model);
  const captain=squad.find(x=>x.is_captain); const vice=squad.find(x=>x.is_vice_captain);
  return {starters,captain,vice};
}

app.get('/api/data', async (_req,res)=>{
  try {
    const d=await load();
    const chips=chipStatus(d.history);
    const squad=d.squad.map(x=>({...x, model:modelScore(x.player,x.next5), selling_price:x.current_selling_price ?? sellPrice(x.player.now_cost/10,x.purchase_price)}));
    const news=squad.map(x=>({id:x.player.id,name:x.player.web_name,status:x.player.status,chance:x.player.chance_of_playing_this_round,news:x.player.news})).filter(x=>x.status!=='a'||x.news||x.chance!=null);
    res.json({teamId:+TEAM_ID,gameweek:d.gw,manager:`${d.entry.player_first_name} ${d.entry.player_last_name}`,teamName:d.entry.name,rank:d.entry.summary_overall_rank,points:d.entry.summary_overall_points,value:d.entry.last_deadline_value/10,bank:d.bank,freeTransfers:d.freeTransfers,transfersThisGW:d.history.current?.find(x=>x.event===d.gw)?.event_transfers||0,squad,allPlayers:d.allPlayers,transfers:d.transfers,history:d.history.current||[],chips,news,fixtures:d.fixtures.filter(f=>f.event>=d.gw),price_updated_at:new Date().toISOString(),price_rules:{daily_max_change:0.1,deadline_uk:'00:00',predictor_refresh:'15 minutes',sell_price_rule:'half of gain retained, rounded down to £0.1m'},source:'Official FPL public data'});
  } catch(e) { res.status(502).json({error:e.message}); }
});

app.post('/api/optimize', async (_req,res)=>{
  try {
    const d=await load(); const owned=new Set(d.squad.map(x=>x.player.id));
    const current=d.squad.map(x=>x.player); const budget=d.bank;
    const pScore=p=>modelScore(p,fixturesFor(d.fixtures,p,d.teams,d.gw).slice(0,5));
    const byPos={1:[],2:[],3:[],4:[]}; d.allPlayers.forEach(p=>byPos[p.element_type].push(p));
    const candidates={};
    for(const p of current){
      candidates[p.id]=byPos[p.element_type].filter(q=>!owned.has(q.id)&&q.status==='a').sort((a,b)=>pScore(b)-pScore(a)).slice(0,12);
    }
    const baseScore=current.reduce((s,p)=>s+pScore(p),0);
    const options=[];
    for(const out of current){
      for(const inn of candidates[out.id]){
        const delta=+((pScore(inn)-pScore(out))).toFixed(2);
        if(delta<=0) continue;
        const outRow=d.squad.find(x=>x.player.id===out.id); const sell=outRow?.current_selling_price ?? sellPrice(out.now_cost/10, outRow?.purchase_price ?? out.now_cost/10); const cost=+(inn.price - sell).toFixed(1);
        if(cost>budget+1e-9) continue;
        const squad=current.map(p=>p.id===out.id?inn:p);
        if(!legalSquad(squad)) continue;
        options.push({moves:[{out:out.web_name,in:inn.web_name,price:inn.price,delta}],gain:delta,cost});
      }
    }
    options.sort((a,b)=>b.gain-a.gain);
    const best={1:options[0]||null,2:null,3:null,4:null,5:null};
    // Beam-search exact legal sequential transfer states; this avoids combinatorial explosion while testing the real squad constraints.
    let beam=[{squad:current,gain:0,cost:0,moves:[]}];
    for(let n=1;n<=5;n++){
      const next=[];
      for(const st of beam){
        const ownedIds=new Set(st.squad.map(p=>p.id));
        for(const out of st.squad){
          const pool=byPos[out.element_type].filter(q=>!ownedIds.has(q.id)&&q.status==='a').sort((a,b)=>pScore(b)-pScore(a)).slice(0,10);
          const outRow=d.squad.find(x=>x.player.id===out.id); const sell=outRow?.current_selling_price ?? sellPrice(out.now_cost/10, outRow?.purchase_price ?? out.now_cost/10);
          for(const inn of pool){
            const newCost=+(st.cost + inn.price - sell).toFixed(1);
            if(newCost>budget+1e-9) continue;
            const sq=st.squad.map(p=>p.id===out.id?inn:p); if(!legalSquad(sq)) continue;
            const delta=+(pScore(inn)-pScore(out)).toFixed(2);
            next.push({squad:sq,gain:+(st.gain+delta).toFixed(2),cost:newCost,moves:[...st.moves,{out:out.web_name,in:inn.web_name,price:inn.price,delta}]});
          }
        }
      }
      next.sort((a,b)=>b.gain-a.gain); beam=next.slice(0,250);
      best[n]=beam[0]||null;
    }
    const ft=d.freeTransfers;
    const summary=[1,2,3,4,5].map(n=>{const x=best[n]; const hits=Math.max(0,n-ft)*4; return {transfers:n,freeTransfers:ft,hits,cost:x?.cost??null,grossGain:x?.gain??null,netGain:x?+(x.gain-hits).toFixed(2):null,moves:x?.moves||[]};});
    const rollGain=0; const bestNet=summary.filter(x=>x.netGain!=null).sort((a,b)=>b.netGain-a.netGain)[0];
    const verdict=bestNet && bestNet.netGain>0.25 ? `Use ${bestNet.transfers} transfer${bestNet.transfers>1?'s':''}` : 'Roll your transfer';
    const state=readState(); state.recommendations.push({at:new Date().toISOString(),gw:d.gw,summary,verdict}); state.recommendations=state.recommendations.slice(-100); writeState(state);
    res.json({gameweek:d.gw,freeTransfers:ft,bank:budget,summary,verdict,modelNote:'Next-five-game projection using official FPL player/fixture data. This is an optimisation model, not a guarantee.'});
  } catch(e) { res.status(502).json({error:e.message}); }
});

app.get('/api/chips', async (_req,res)=>{
  try { const d=await load(); const used=d.history.chips||[]; const doubles={}; const blanks={};
    for(const f of d.fixtures){ if(f.event==null) continue; (doubles[f.event]??=[]); (blanks[f.event]??=[]); }
    const byGw={}; for(const f of d.fixtures){ if(f.event==null)continue; (byGw[f.event]??=new Set()).add(f.team_h); byGw[f.event].add(f.team_a); }
    const doublesOut=Object.entries(byGw).filter(([gw,set])=>set.size<20).map(([gw,set])=>({gw:+gw,teamsWithFixture:set.size}));
    res.json({gameweek:d.gw,used,chips:chipStatus(d.history),doubleOrBlankCandidates:doublesOut});
  } catch(e){res.status(502).json({error:e.message});}
});
app.get('/api/state',(_req,res)=>res.json(readState()));
app.get('/api/health',(_req,res)=>res.json({ok:true,teamId:+TEAM_ID,version:'2.0.0'}));
app.listen(PORT,()=>console.log(`FPL Edge 2.0 on http://localhost:${PORT}`));
