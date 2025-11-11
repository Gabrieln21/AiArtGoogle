#!/usr/bin/env node
// Simple concurrent load test for /api/generate
// Usage:
//   node scripts/stress_generate.mjs --url http://localhost:3000 --n 40 --c 20
// Optional (use server fake mode from the edit below to avoid costs):
//   node scripts/stress_generate.mjs --url https://your.host --n 200 --c 40 --fake

const args = Object.fromEntries(
    process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : []))
);
const BASE = (args.url || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOTAL = parseInt(args.n || '40', 10);          // total requests
const CONC  = parseInt(args.c || '20', 10);          // concurrency
const FAKE  = args.fake ? true : false;              // send X-Load-Test: fake
const PATH  = '/api/generate';

const prompts = [
    'Ship at sea', 'Storm over mountains', 'Dancer with flowing scarf',
    'Forest clearing', 'Cathedral arches', 'Flying fish', 'Solar eclipse',
    'Waves and lighthouse', 'Hands weaving thread', 'City skyline at dawn'
];
const searches = [
    'the kraken', 'renewable energy', 'mangrove roots', 'migration patterns',
    'lithography techniques', 'etching ink density', 'ocean acidification',
    'kepler exoplanets', 'paper grain direction', 'artisanal printing'
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function one(i){
    const t0 = process.hrtime.bigint();
    try {
        const fd = new FormData();
        fd.append('prompt', pick(prompts) + ' #' + i);
        fd.append('lastSearch', pick(searches));

        const res = await fetch(`${BASE}${PATH}${FAKE ? '?fake=1' : ''}`, {
            method: 'POST',
            headers: FAKE ? {'x-load-test':'fake'} : undefined,
            body: fd
        });

        const t1 = process.hrtime.bigint();
        const ms = Number(t1 - t0) / 1e6;

        if (!res.ok) {
            const txt = await res.text().catch(()=>String(res.status));
            return { ok:false, ms, status:res.status, err:txt.slice(0,150) };
        }
        const j = await res.json().catch(()=>({}));
        return { ok:true, ms, status:res.status, id:j?.id ?? null };
    } catch (e) {
        const t1 = process.hrtime.bigint();
        const ms = Number(t1 - t0) / 1e6;
        return { ok:false, ms, status:0, err:String(e).slice(0,150) };
    }
}

async function run(){
    console.log(`\n== bombard ==\nURL: ${BASE}${PATH}\nRequests: ${TOTAL}\nConcurrency: ${CONC}\nFake mode: ${FAKE}\n`);
    const inFlight = new Set();
    const results = [];

    let launched = 0;
    let completed = 0;

    function pump(){
        while (inFlight.size < CONC && launched < TOTAL){
            const p = one(launched);
            inFlight.add(p);
            launched++;
            p.then(r=>{
                results.push(r);
                inFlight.delete(p);
                completed++;
                if (completed % Math.max(1, Math.floor(TOTAL/10)) === 0){
                    process.stdout.write(`… ${completed}/${TOTAL}\r`);
                }
                pump();
            });
        }
    }

    pump();
    while (inFlight.size) await Promise.race([...inFlight]);

    const ok = results.filter(r=>r.ok);
    const ko = results.filter(r=>!r.ok);

    const lat = ok.map(r=>r.ms).sort((a,b)=>a-b);
    function pct(p){ return lat.length ? lat[Math.min(lat.length-1, Math.floor(p*lat.length))] : NaN; }
    const sum = lat.reduce((a,b)=>a+b,0);
    const avg = lat.length ? sum/lat.length : NaN;

    console.log(`\nDone.\nSuccess: ${ok.length}  Fail: ${ko.length}`);
    if (lat.length){
        console.log(`Latency ms  p50=${pct(0.50).toFixed(1)}  p90=${pct(0.90).toFixed(1)}  p95=${pct(0.95).toFixed(1)}  p99=${pct(0.99).toFixed(1)}  avg=${avg.toFixed(1)}`);
    }
    if (ko.length){
        const byStatus = [...ko.reduce((m,r)=>m.set(r.status,(m.get(r.status)||0)+1), new Map())]
            .sort((a,b)=>b[1]-a[1]).map(([s,c])=>`${s}:${c}`).join(', ');
        console.log(`Failures by status: ${byStatus}`);
        const sample = ko.slice(0,5).map(r=>`- ${r.status} ${r.err}`).join('\n');
        if (sample) console.log(`Sample errors:\n${sample}`);
    }
}

run();
