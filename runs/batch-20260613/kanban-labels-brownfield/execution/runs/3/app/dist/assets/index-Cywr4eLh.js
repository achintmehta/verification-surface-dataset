(function(){const a=document.createElement("link").relList;if(a&&a.supports&&a.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))n(r);new MutationObserver(r=>{for(const o of r)if(o.type==="childList")for(const s of o.addedNodes)s.tagName==="LINK"&&s.rel==="modulepreload"&&n(s)}).observe(document,{childList:!0,subtree:!0});function t(r){const o={};return r.integrity&&(o.integrity=r.integrity),r.referrerPolicy&&(o.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?o.credentials="include":r.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function n(r){if(r.ep)return;r.ep=!0;const o=t(r);fetch(r.href,o)}})();const y="http://localhost:3001",$=document.querySelector("#app");let p={columns:[]},u=[],h=new Set,g=null,b=null,I=null;function i(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function x(e){for(const a of p.columns){const t=a.cards.findIndex(n=>n.id===e);if(t!==-1)return{column:a,index:t,card:a.cards[t]}}return null}function C(e){let a=null;for(const t of p.columns){const n=t.cards.findIndex(r=>r.id===e);if(n!==-1){const[r]=t.cards.splice(n,1);a=r}}return a}function L(e){const a=new Set;return{columns:[...e.columns||[]].map(n=>({...n,cards:[...n.cards||[]].filter(r=>a.has(r.id)?!1:(a.add(r.id),!0)).map(r=>({...r,labels:r.labels||[]})).sort(S)})).sort((n,r)=>Number(n.position)-Number(r.position)||n.id.localeCompare(r.id))}}function S(e,a){return Number(e.position)-Number(a.position)||String(e.created_at).localeCompare(String(a.created_at))||e.id.localeCompare(a.id)}function A(e){if(h.size===0)return!0;const a=new Set((e.labels||[]).map(t=>t.id));for(const t of h)if(a.has(t))return!0;return!1}function m(){$.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    ${k()}
    <main class="board">
      ${p.columns.map(j).join("")}
    </main>
    ${T()}
  `,N()}function k(){if(u.length===0)return"";const e=u.map(t=>{const n=h.has(t.id);return`<button
      class="filter-chip${n?" active":""}"
      data-filter-label-id="${i(t.id)}"
      style="--chip-color:${i(t.color)}"
      title="${n?"Remove filter":"Filter by"} ${i(t.name)}"
    >${i(t.name)}</button>`}).join(""),a=h.size>0?'<button class="filter-clear" id="filter-clear-btn">Clear filter</button>':"";return`
    <div class="filter-bar">
      <span class="filter-label-text">Filter:</span>
      ${e}
      ${a}
      <button class="manage-labels-btn" id="open-label-manager">⚙ Labels</button>
    </div>
  `}function j(e){const a=e.cards.filter(A),t=e.cards.length-a.length,n=t>0?`<p class="hidden-note">${t} card${t>1?"s":""} hidden by filter</p>`:"";return`
    <section class="column" data-column-id="${i(e.id)}">
      <h2>${i(e.title)}</h2>
      <form class="add-card" data-column-id="${i(e.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      ${n}
      <div class="cards" data-column-id="${i(e.id)}">
        ${a.map(O).join("")}
      </div>
    </section>
  `}function O(e){const a=(e.labels||[]).map(n=>`<span class="label-chip" style="background:${i(n.color)}" title="${i(n.name)}">${i(n.name)}</span>`).join(""),t=a?`<div class="card-labels">${a}</div>`:"";return`
    <article class="card" draggable="true" data-card-id="${i(e.id)}" title="Drag to move">
      <div class="card-text">${i(e.text)}</div>
      ${t}
      <button class="card-label-btn" data-card-id="${i(e.id)}" title="Manage labels">🏷</button>
    </article>
  `}function T(){return`
    <div class="label-manager-overlay" id="label-manager-overlay" style="display:none">
      <div class="label-manager" id="label-manager">
        <div class="label-manager-header">
          <h2>Labels</h2>
          <button class="label-manager-close" id="close-label-manager">✕</button>
        </div>
        <ul class="label-list" id="label-list">
          ${u.map(B).join("")}
        </ul>
        <form class="label-create-form" id="label-create-form">
          <input name="name" type="text" maxlength="50" placeholder="Label name…" autocomplete="off" required />
          <input name="color" type="color" value="#3b82f6" title="Pick a color" />
          <button type="submit">Add</button>
        </form>
      </div>
    </div>
    <div class="card-label-overlay" id="card-label-overlay" style="display:none">
      <div class="card-label-panel" id="card-label-panel">
        <div class="label-manager-header">
          <h2>Card Labels</h2>
          <button class="label-manager-close" id="close-card-label-panel">✕</button>
        </div>
        <ul class="card-label-list" id="card-label-list"></ul>
      </div>
    </div>
  `}function B(e){return`
    <li class="label-row" data-label-id="${i(e.id)}">
      <span class="label-swatch" style="background:${i(e.color)}"></span>
      <span class="label-row-name">${i(e.name)}</span>
      <button class="label-edit-btn" data-label-id="${i(e.id)}" title="Edit">✏</button>
      <button class="label-delete-btn" data-label-id="${i(e.id)}" title="Delete">🗑</button>
    </li>
  `}function N(){document.querySelectorAll(".add-card").forEach(l=>{l.addEventListener("submit",async d=>{d.preventDefault();const f=l.elements.text,v=f.value.trim();v&&(f.value="",await F(l.dataset.columnId,v))})}),document.querySelectorAll(".card").forEach(l=>{l.addEventListener("dragstart",d=>{g=l.dataset.cardId,l.classList.add("dragging"),d.dataTransfer.effectAllowed="move"}),l.addEventListener("dragend",()=>{l.classList.remove("dragging"),g=null})}),document.querySelectorAll(".cards").forEach(l=>{l.addEventListener("dragover",d=>{d.preventDefault(),l.classList.add("drop-target")}),l.addEventListener("dragleave",()=>l.classList.remove("drop-target")),l.addEventListener("drop",async d=>{if(d.preventDefault(),l.classList.remove("drop-target"),!g)return;const f=l.dataset.columnId,{afterId:v,beforeId:E}=q(l,g),w=g;D(w,f,E,v),m(),await H(w,f,E,v)})}),document.querySelectorAll(".filter-chip").forEach(l=>{l.addEventListener("click",()=>{const d=l.dataset.filterLabelId;h.has(d)?h.delete(d):h.add(d),m()})});const e=document.getElementById("filter-clear-btn");e&&e.addEventListener("click",()=>{h.clear(),m()});const a=document.getElementById("open-label-manager");a&&a.addEventListener("click",()=>{document.getElementById("label-manager-overlay").style.display="flex"});const t=document.getElementById("close-label-manager");t&&t.addEventListener("click",()=>{document.getElementById("label-manager-overlay").style.display="none"});const n=document.getElementById("label-manager-overlay");n&&n.addEventListener("click",l=>{l.target===n&&(n.style.display="none")});const r=document.getElementById("label-create-form");r&&r.addEventListener("submit",async l=>{l.preventDefault();const d=r.elements.name.value.trim(),f=r.elements.color.value;if(!d)return;await J(d,f)&&(r.elements.name.value="")}),document.querySelectorAll(".label-edit-btn").forEach(l=>{l.addEventListener("click",()=>P(l.dataset.labelId))}),document.querySelectorAll(".label-delete-btn").forEach(l=>{l.addEventListener("click",()=>R(l.dataset.labelId))}),document.querySelectorAll(".card-label-btn").forEach(l=>{l.addEventListener("click",d=>{d.stopPropagation(),M(l.dataset.cardId)})});const o=document.getElementById("close-card-label-panel");o&&o.addEventListener("click",()=>{document.getElementById("card-label-overlay").style.display="none"});const s=document.getElementById("card-label-overlay");s&&s.addEventListener("click",l=>{l.target===s&&(s.style.display="none")})}function P(e){const a=u.find(l=>l.id===e);if(!a)return;const t=prompt("Rename label:",a.name);if(t===null)return;const n=t.trim();if(!n){alert("Label name cannot be empty.");return}const r=document.createElement("input");r.type="color",r.value=a.color,r.style.position="fixed",r.style.opacity="0",r.style.pointerEvents="none",document.body.appendChild(r);const o=prompt("Color (hex, e.g. #3b82f6):",a.color);if(document.body.removeChild(r),o===null)return;const s=o.trim();if(!/^#[0-9a-fA-F]{6}$/.test(s)){alert("Invalid hex color. Use format #rrggbb.");return}U(e,n,s)}function M(e){const a=x(e);if(!a)return;const t=a.card,n=new Set((t.labels||[]).map(o=>o.id)),r=document.getElementById("card-label-list");r.innerHTML=u.length===0?'<li class="no-labels-note">No labels yet. Create some in ⚙ Labels.</li>':u.map(o=>{const s=n.has(o.id);return`<li class="card-label-item">
          <label>
            <input type="checkbox" class="card-label-checkbox"
              data-card-id="${i(e)}"
              data-label-id="${i(o.id)}"
              ${s?"checked":""} />
            <span class="label-swatch" style="background:${i(o.color)}"></span>
            ${i(o.name)}
          </label>
        </li>`}).join(""),r.querySelectorAll(".card-label-checkbox").forEach(o=>{o.addEventListener("change",async()=>{const s=o.dataset.cardId,l=o.dataset.labelId;o.checked?await _(s,l):await z(s,l)})}),document.getElementById("card-label-overlay").style.display="flex"}function q(e,a){const t=[...e.querySelectorAll(".card")].map(r=>r.dataset.cardId),n=t.indexOf(a);return{afterId:n>0?t[n-1]:null,beforeId:n>=0&&n<t.length-1?t[n+1]:null}}function D(e,a,t,n){const r=C(e);if(!r)return;const o=p.columns.find(f=>f.id===a);if(!o)return;const s=n?o.cards.findIndex(f=>f.id===n):-1,l=t?o.cards.findIndex(f=>f.id===t):-1;let d=o.cards.length;s!==-1?d=s+1:l!==-1&&(d=l),o.cards.splice(d,0,{...r,column_id:a,optimistic:!0})}async function F(e,a){try{const t=await fetch(`${y}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:e,text:a})});if(!t.ok)throw new Error((await t.json()).error||"Create failed")}catch(t){c(`Create failed: ${t.message}`,!0)}}async function H(e,a,t,n){try{const r=await fetch(`${y}/api/cards/${e}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:a,beforeId:t,afterId:n})});if(!r.ok)throw new Error((await r.json()).error||"Move failed")}catch(r){c(`Move failed: ${r.message}`,!0)}}async function J(e,a){try{const t=await fetch(`${y}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:e,color:a})});if(!t.ok){const n=await t.json();return alert(n.error||"Failed to create label"),!1}return!0}catch(t){return c(`Label create failed: ${t.message}`,!0),!1}}async function U(e,a,t){try{const n=await fetch(`${y}/api/labels/${e}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:a,color:t})});if(!n.ok){const r=await n.json();alert(r.error||"Failed to update label")}}catch(n){c(`Label update failed: ${n.message}`,!0)}}async function R(e){if(confirm("Delete this label? It will be removed from all cards."))try{const a=await fetch(`${y}/api/labels/${e}`,{method:"DELETE"});if(!a.ok&&a.status!==404){const t=await a.json();alert(t.error||"Failed to delete label")}}catch(a){c(`Label delete failed: ${a.message}`,!0)}}async function _(e,a){try{const t=await fetch(`${y}/api/cards/${e}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:a})});if(!t.ok){const n=await t.json();c(`Assign failed: ${n.error}`,!0)}}catch(t){c(`Assign failed: ${t.message}`,!0)}}async function z(e,a){try{const t=await fetch(`${y}/api/cards/${e}/labels/${a}`,{method:"DELETE"});if(!t.ok){const n=await t.json();c(`Unassign failed: ${n.error}`,!0)}}catch(t){c(`Unassign failed: ${t.message}`,!0)}}function K(e){if(e.board){p=L(e.board),m(),c("Synced");return}if(!e.card)return;const a=e.card;C(a.id);const t=p.columns.find(n=>n.id===a.column_id||n.id===e.columnId);t&&(t.cards.push({...a,labels:a.labels||[]}),t.cards.sort(S),m(),c("Synced"))}function G(e){const{type:a}=e;if(a==="label-created"){u.find(t=>t.id===e.label.id)||(u.push(e.label),u.sort((t,n)=>t.name.localeCompare(n.name))),m(),c("Synced");return}if(a==="label-updated"){const t=u.findIndex(n=>n.id===e.label.id);t!==-1?u[t]=e.label:u.push(e.label),u.sort((n,r)=>n.name.localeCompare(r.name)),e.board&&(p=L(e.board)),m(),c("Synced");return}if(a==="label-deleted"){u=u.filter(t=>t.id!==e.labelId),h.delete(e.labelId),e.board&&(p=L(e.board)),m(),c("Synced");return}if(a==="card-label-assigned"||a==="card-label-unassigned"){e.board&&(p=L(e.board)),m(),c("Synced");return}}async function Q(){const e=await fetch(`${y}/api/board`);if(!e.ok)throw new Error("Could not load board");p=L(await e.json())}async function V(){const e=await fetch(`${y}/api/labels`);if(!e.ok)throw new Error("Could not load labels");u=await e.json()}function W(){b==null||b.close(),b=new EventSource(`${y}/api/stream`),b.addEventListener("connected",()=>c("Live")),b.addEventListener("mutation",e=>{K(JSON.parse(e.data))}),b.addEventListener("label",e=>{G(JSON.parse(e.data))}),b.onerror=()=>c("Reconnecting…",!0)}function c(e,a=!1){const t=document.querySelector("#status");t&&(t.textContent=e,t.classList.toggle("warn",a)),clearTimeout(I),a&&(I=setTimeout(()=>c((b==null?void 0:b.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function X(){$.innerHTML='<div class="loading">Loading board…</div>';try{await Promise.all([Q(),V()]),m(),W()}catch(e){$.innerHTML=`<div class="loading error">${i(e.message)}</div>`}}X();
