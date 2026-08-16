(function(){const s=document.createElement("link").relList;if(s&&s.supports&&s.supports("modulepreload"))return;for(const a of document.querySelectorAll('link[rel="modulepreload"]'))o(a);new MutationObserver(a=>{for(const r of a)if(r.type==="childList")for(const h of r.addedNodes)h.tagName==="LINK"&&h.rel==="modulepreload"&&o(h)}).observe(document,{childList:!0,subtree:!0});function n(a){const r={};return a.integrity&&(r.integrity=a.integrity),a.referrerPolicy&&(r.referrerPolicy=a.referrerPolicy),a.crossOrigin==="use-credentials"?r.credentials="include":a.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function o(a){if(a.ep)return;a.ep=!0;const r=n(a);fetch(a.href,r)}})();const b="http://localhost:3000",y="seat-booking-session-id";let d=localStorage.getItem(y);d||(d=`session-${crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)}`,localStorage.setItem(y,d));const e={seats:[],inventory:null,selected:new Set,currentHold:null,ttlSeconds:30,notice:"Loading seats…",conflicts:new Set},L=document.querySelector("#app");L.innerHTML=`
  <main class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Live single-event seat map</p>
        <h1>Seat Booking</h1>
        <p class="subtle">Select available seats, place a temporary hold, then confirm before the countdown expires.</p>
      </div>
      <div class="session-card">
        <span>Your session</span>
        <code id="session-id"></code>
      </div>
    </header>

    <section class="toolbar">
      <div class="inventory" id="inventory"></div>
      <div class="actions">
        <button id="hold-btn" type="button">Hold selected seats</button>
        <button id="confirm-btn" type="button" disabled>Confirm hold</button>
        <button id="release-btn" type="button" disabled>Release hold</button>
      </div>
    </section>

    <section id="hold-panel" class="hold-panel hidden"></section>
    <p id="notice" class="notice"></p>

    <section class="stage" aria-label="Seat map">
      <div class="screen">STAGE</div>
      <div id="seat-grid" class="seat-grid"></div>
    </section>

    <section class="legend" aria-label="Legend">
      <span><i class="swatch available"></i> Available</span>
      <span><i class="swatch selected"></i> Selected</span>
      <span><i class="swatch held"></i> Held</span>
      <span><i class="swatch mine"></i> Your hold</span>
      <span><i class="swatch booked"></i> Booked</span>
    </section>
  </main>
`;document.querySelector("#session-id").textContent=d;const g=document.querySelector("#seat-grid"),$=document.querySelector("#inventory"),I=document.querySelector("#notice"),u=document.querySelector("#hold-panel"),m=document.querySelector("#hold-btn"),v=document.querySelector("#confirm-btn"),w=document.querySelector("#release-btn");async function p(t,s={}){const n=await fetch(`${b}${t}`,{...s,headers:{"Content-Type":"application/json",...s.headers||{}}}),o=await n.text(),a=o?JSON.parse(o):{};if(!n.ok){const r=new Error(a.error||`HTTP ${n.status}`);throw r.status=n.status,r.body=a,r}return a}function H(t){return`${t.rowLabel}${t.seatNumber}`}function l(t){e.inventory=t,t&&($.innerHTML=`
    <span><strong>${t.available}</strong> available</span>
    <span><strong>${t.held}</strong> held</span>
    <span><strong>${t.booked}</strong> booked</span>
    <span><strong>${t.total}</strong> total</span>
  `)}function E(t){var n;const s=["seat",t.status];return e.selected.has(t.id)&&s.push("selected"),e.conflicts.has(t.id)&&s.push("conflict"),(n=e.currentHold)!=null&&n.id&&t.holdId===e.currentHold.id&&t.status==="held"&&s.push("mine"),s.join(" ")}function N(){const t=new Map;for(const s of e.seats)t.has(s.rowLabel)||t.set(s.rowLabel,[]),t.get(s.rowLabel).push(s);g.innerHTML=[...t.entries()].map(([s,n])=>`
    <div class="row-label">${s}</div>
    <div class="row-seats">
      ${n.map(o=>`
        <button class="${E(o)}" data-seat-id="${o.id}" ${o.status!=="available"?"disabled":""} title="${H(o)} ${o.status}">
          ${o.seatNumber}
        </button>
      `).join("")}
    </div>
  `).join(""),m.disabled=e.selected.size===0||!!e.currentHold,v.disabled=!e.currentHold,w.disabled=!e.currentHold}function S(){if(!e.currentHold){u.classList.add("hidden"),u.innerHTML="";return}const t=Math.max(0,Math.ceil((new Date(e.currentHold.expiresAt).getTime()-Date.now())/1e3)),s=e.currentHold.seatIds.map(n=>e.seats.find(o=>o.id===n)).filter(Boolean).map(H).join(", ");u.classList.remove("hidden"),u.innerHTML=`
    <div>
      <strong>Current hold:</strong> ${s||e.currentHold.seatIds.join(", ")}
      <span class="timer ${t<=5?"urgent":""}">${t}s left</span>
    </div>
    <small>Hold id ${e.currentHold.id}</small>
  `,t<=0&&(e.notice="Your hold expired. Those seats may be selected again if still available.",e.currentHold=null,c())}function i(){I.textContent=e.notice,N(),S()}function f(t){const s=new Map(e.seats.map(n=>[n.id,n]));for(const n of t)s.set(n.id,{...s.get(n.id),...n});e.seats=[...s.values()].sort((n,o)=>n.rowLabel.localeCompare(o.rowLabel)||n.seatNumber-o.seatNumber);for(const n of[...e.selected]){const o=s.get(n);(!o||o.status!=="available")&&e.selected.delete(n)}if(e.currentHold){const n=e.currentHold.seatIds.every(a=>{const r=s.get(a);return(r==null?void 0:r.status)==="held"&&r.holdId===e.currentHold.id}),o=e.currentHold.seatIds.every(a=>{var r;return((r=s.get(a))==null?void 0:r.status)==="booked"});!n&&!o&&(e.currentHold=null)}}async function c(){const t=await p("/api/seats");e.seats=t.seats,e.ttlSeconds=t.ttlSeconds,l(t.inventory),e.selected.clear(),e.conflicts.clear(),e.notice="Seat map is live.",i()}g.addEventListener("click",t=>{const s=t.target.closest("[data-seat-id]");if(!s)return;const n=Number(s.dataset.seatId),o=e.seats.find(a=>a.id===n);!o||o.status!=="available"||e.currentHold||(e.conflicts.clear(),e.selected.has(n)?e.selected.delete(n):e.selected.add(n),e.notice=`${e.selected.size} seat(s) selected.`,i())});m.addEventListener("click",async()=>{try{m.disabled=!0;const t=await p("/api/holds",{method:"POST",body:JSON.stringify({seatIds:[...e.selected],sessionId:d})});e.currentHold=t.hold,e.selected.clear(),e.conflicts.clear(),f(t.seats),l(t.inventory),e.notice="Hold placed. Confirm before the countdown reaches zero.",i()}catch(t){t.status===409?(e.conflicts=new Set((t.body.conflicts||[]).map(s=>s.id)),e.notice="Hold failed: highlighted seats were already taken. Refreshing map…",await c()):(e.notice=t.message,i())}});v.addEventListener("click",async()=>{if(e.currentHold)try{const t=e.currentHold.id,s=await p(`/api/holds/${t}/confirm`,{method:"POST",body:JSON.stringify({sessionId:d})});f(s.seats),l(s.inventory),e.currentHold=null,e.notice=s.booking.alreadyConfirmed?"Booking was already confirmed.":"Booking confirmed!",i()}catch(t){e.currentHold=null,e.notice=`${t.message}. Nothing was booked.`,await c()}});w.addEventListener("click",async()=>{if(e.currentHold)try{const t=e.currentHold.id,s=await p(`/api/holds/${t}`,{method:"DELETE",body:JSON.stringify({sessionId:d})});f(s.released),l(s.inventory),e.currentHold=null,e.notice="Hold released.",i()}catch(t){e.currentHold=null,e.notice=t.message,await c()}});function k(){const t=new EventSource(`${b}/api/stream`);t.addEventListener("hello",s=>{const n=JSON.parse(s.data);l(n.inventory)}),t.addEventListener("seats",s=>{const n=JSON.parse(s.data);f(n.seats||[]),l(n.inventory),n.type==="held"&&(e.notice="Live update: seats were held."),n.type==="booked"&&(e.notice="Live update: seats were booked."),n.type==="released"&&(e.notice="Live update: seats were released."),i()}),t.onerror=()=>{e.notice="Live connection interrupted; browser will retry automatically.",i()}}setInterval(()=>{e.currentHold&&S()},500);c().catch(t=>{e.notice=`Failed to load seats: ${t.message}`,i()});k();
