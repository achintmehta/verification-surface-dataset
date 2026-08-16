(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const o of document.querySelectorAll('link[rel="modulepreload"]'))a(o);new MutationObserver(o=>{for(const r of o)if(r.type==="childList")for(const l of r.addedNodes)l.tagName==="LINK"&&l.rel==="modulepreload"&&a(l)}).observe(document,{childList:!0,subtree:!0});function n(o){const r={};return o.integrity&&(r.integrity=o.integrity),o.referrerPolicy&&(r.referrerPolicy=o.referrerPolicy),o.crossOrigin==="use-credentials"?r.credentials="include":o.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function a(o){if(o.ep)return;o.ep=!0;const r=n(o);fetch(o.href,r)}})();const v="http://localhost:3000",w="seat-booking-session-id";let c=localStorage.getItem(w);var y;c||(c=((y=crypto.randomUUID)==null?void 0:y.call(crypto))||`${Date.now()}-${Math.random()}`,localStorage.setItem(w,c));const s={seats:[],selected:new Set,currentHold:null,countdownTimer:null},I=document.querySelector("#app");I.innerHTML=`
  <main class="shell">
    <header>
      <div>
        <h1>Seat Booking</h1>
        <p class="muted">Session: <code>${c}</code></p>
      </div>
      <div id="connection" class="pill">Connecting…</div>
    </header>

    <section class="toolbar">
      <div id="inventory" class="inventory"></div>
      <div class="actions">
        <button id="holdBtn" disabled>Hold selected seats</button>
        <button id="confirmBtn" disabled>Confirm hold</button>
        <button id="releaseBtn" disabled>Release hold</button>
      </div>
    </section>

    <section id="holdPanel" class="hold-panel hidden"></section>
    <section id="message" class="message hidden"></section>
    <section id="seatGrid" class="seat-grid" aria-label="Seat map"></section>

    <footer class="legend">
      <span><i class="swatch available"></i>Available</span>
      <span><i class="swatch selected"></i>Selected</span>
      <span><i class="swatch held"></i>Held</span>
      <span><i class="swatch booked"></i>Booked</span>
    </footer>
  </main>
`;const m=document.querySelector("#seatGrid"),L=document.querySelector("#inventory"),b=document.querySelector("#message"),i=document.querySelector("#holdPanel"),H=document.querySelector("#holdBtn"),S=document.querySelector("#confirmBtn"),E=document.querySelector("#releaseBtn"),f=document.querySelector("#connection");function d(e,t="info"){b.textContent=e,b.className=`message ${t}`,e&&setTimeout(()=>b.classList.add("hidden"),7e3)}function $(e){var n,a;const t=["seat",e.status];return s.selected.has(e.id)&&t.push("selected"),(a=(n=s.currentHold)==null?void 0:n.seatIds)!=null&&a.includes(e.id)&&e.status==="held"&&t.push("mine"),t.join(" ")}function u(){const e=new Map;for(const n of s.seats)e.has(n.rowLabel)||e.set(n.rowLabel,[]),e.get(n.rowLabel).push(n);m.innerHTML="";for(const[n,a]of e){const o=document.createElement("div");o.className="row-label",o.textContent=n,m.appendChild(o);for(const r of a){const l=document.createElement("button");l.className=$(r),l.textContent=r.seatNumber,l.title=`${r.id}: ${r.status}`,l.disabled=r.status!=="available"&&!s.selected.has(r.id),l.addEventListener("click",()=>N(r.id)),m.appendChild(l)}}const t=s.seats.reduce((n,a)=>(n[a.status]=(n[a.status]||0)+1,n.total+=1,n),{available:0,held:0,booked:0,total:0});L.innerHTML=`
    <strong>${t.total}</strong> total
    <span>${t.available} available</span>
    <span>${t.held} held</span>
    <span>${t.booked} booked</span>
  `,H.disabled=s.selected.size===0||!!s.currentHold,S.disabled=!s.currentHold,E.disabled=!s.currentHold}function N(e){const t=s.seats.find(n=>n.id===e);!t||t.status!=="available"||(s.selected.has(e)?s.selected.delete(e):s.selected.add(e),u())}async function p(e,t={}){const n=await fetch(`${v}${e}`,{headers:{"Content-Type":"application/json",...t.headers||{}},...t}),a=await n.json().catch(()=>({}));if(!n.ok){const o=new Error(a.error||`HTTP ${n.status}`);throw o.status=n.status,o.data=a,o}return a}async function h(){const e=await p("/api/seats");s.seats=e.seats,s.selected.clear(),u()}function g(){if(clearInterval(s.countdownTimer),!s.currentHold){i.className="hold-panel hidden";return}const e=()=>{if(!s.currentHold)return;const t=Math.max(0,Math.ceil((new Date(s.currentHold.expiresAt).getTime()-Date.now())/1e3));i.className="hold-panel",i.innerHTML=`
      <strong>Holding ${s.currentHold.seatIds.join(", ")}</strong>
      <span>Expires in ${t}s</span>
    `,t<=0&&(clearInterval(s.countdownTimer),s.currentHold=null,i.className="hold-panel hidden",d("Your hold expired.","warn"),h().catch(console.error)),u()};e(),s.countdownTimer=setInterval(e,250)}H.addEventListener("click",async()=>{try{const e=[...s.selected],t=await p("/api/holds",{method:"POST",body:JSON.stringify({seatIds:e,sessionId:c})});s.currentHold=t.hold,s.selected.clear();for(const n of t.hold.seatIds){const a=s.seats.find(o=>o.id===n);a&&Object.assign(a,{status:"held",holdId:t.hold.id,holdExpiresAt:t.hold.expiresAt})}d(`Hold created for ${t.hold.seatIds.join(", ")}`,"success"),g(),u()}catch(e){e.status===409?d(`Hold failed. Already taken: ${(e.data.conflictingSeatIds||[]).join(", ")}`,"error"):d(e.message,"error"),h().catch(console.error)}});S.addEventListener("click",async()=>{if(s.currentHold)try{const e=await p(`/api/holds/${s.currentHold.id}/confirm`,{method:"POST",body:JSON.stringify({sessionId:c})});for(const t of e.booking.seatIds){const n=s.seats.find(a=>a.id===t);n&&Object.assign(n,{status:"booked",holdId:null,holdExpiresAt:null,bookedBy:c})}s.currentHold=null,clearInterval(s.countdownTimer),i.className="hold-panel hidden",d(`Booking confirmed: ${e.booking.id}`,"success"),u()}catch(e){d(e.message,"error"),s.currentHold=null,g(),h().catch(console.error)}});E.addEventListener("click",async()=>{if(s.currentHold)try{const e=s.currentHold;await p(`/api/holds/${e.id}`,{method:"DELETE",body:JSON.stringify({sessionId:c})}),s.currentHold=null,clearInterval(s.countdownTimer),i.className="hold-panel hidden",d("Hold released.","success"),await h()}catch(e){d(e.message,"error")}});function T(e){for(const t of e||[]){const n=s.seats.find(a=>a.id===t.id);n&&Object.assign(n,{status:t.status,holdId:t.holdId??null,holdExpiresAt:t.holdExpiresAt??null,bookedBy:t.bookedBy??n.bookedBy??null}),t.status!=="available"&&s.selected.delete(t.id)}s.currentHold&&(e!=null&&e.some(t=>s.currentHold.seatIds.includes(t.id)&&t.status==="available"))&&(s.currentHold=null,g()),u()}function k(){const e=new EventSource(`${v}/api/stream`);e.addEventListener("connected",()=>{f.textContent="Live",f.className="pill live"}),e.addEventListener("seats",t=>{const n=JSON.parse(t.data);T(n.seats)}),e.onerror=()=>{f.textContent="Reconnecting…",f.className="pill warn"}}h().catch(e=>d(e.message,"error"));k();
