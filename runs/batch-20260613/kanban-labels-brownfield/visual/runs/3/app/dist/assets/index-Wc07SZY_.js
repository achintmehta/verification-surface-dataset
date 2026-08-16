(function(){const a=document.createElement("link").relList;if(a&&a.supports&&a.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))r(n);new MutationObserver(n=>{for(const l of n)if(l.type==="childList")for(const s of l.addedNodes)s.tagName==="LINK"&&s.rel==="modulepreload"&&r(s)}).observe(document,{childList:!0,subtree:!0});function e(n){const l={};return n.integrity&&(l.integrity=n.integrity),n.referrerPolicy&&(l.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?l.credentials="include":n.crossOrigin==="anonymous"?l.credentials="omit":l.credentials="same-origin",l}function r(n){if(n.ep)return;n.ep=!0;const l=e(n);fetch(n.href,l)}})();const b="http://localhost:3001",$=document.querySelector("#app");let d={columns:[]},i=[],f=new Set,y=null,c=null,L=null;function o(t){return String(t).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function w(t){let a=null;for(const e of d.columns){const r=e.cards.findIndex(n=>n.id===t);if(r!==-1){const[n]=e.cards.splice(r,1);a=n}}return a}function v(t){const a=new Set;return{columns:[...t.columns||[]].map(r=>({...r,cards:[...r.cards||[]].filter(n=>a.has(n.id)?!1:(a.add(n.id),!0)).map(n=>({...n,labels:n.labels||[]})).sort(E)})).sort((r,n)=>Number(r.position)-Number(n.position)||r.id.localeCompare(n.id))}}function E(t,a){return Number(t.position)-Number(a.position)||String(t.created_at).localeCompare(String(a.created_at))||t.id.localeCompare(a.id)}function S(t){if(f.size===0)return!0;const a=new Set((t.labels||[]).map(e=>e.id));for(const e of f)if(a.has(e))return!0;return!1}function p(){$.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    ${C()}
    <main class="board">
      ${d.columns.map(I).join("")}
    </main>
    ${q()}
  `,A()}function C(){if(i.length===0)return"";const t=i.map(e=>`<button
      class="filter-chip${f.has(e.id)?" active":""}"
      data-filter-label-id="${o(e.id)}"
      style="--chip-color:${o(e.color)}"
      title="Filter by ${o(e.name)}"
    >${o(e.name)}</button>`).join(""),a=f.size>0?'<button class="filter-clear" id="filter-clear-btn">Clear filter</button>':"";return`
    <div class="filter-bar">
      <span class="filter-label-text">Filter:</span>
      ${t}
      ${a}
    </div>
  `}function I(t){return`
    <section class="column" data-column-id="${o(t.id)}">
      <h2>${o(t.title)}</h2>
      <form class="add-card" data-column-id="${o(t.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${o(t.id)}">
        ${t.cards.map(a=>x(a,S(a))).join("")}
      </div>
    </section>
  `}function x(t,a=!0){const e=(t.labels||[]).map(l=>`<span class="label-chip" style="background:${o(l.color)}" title="${o(l.name)}">${o(l.name)}</span>`).join(""),r=i.map(l=>{const s=(t.labels||[]).some(m=>m.id===l.id);return`<button
      class="label-assign-btn${s?" assigned":""}"
      data-card-id="${o(t.id)}"
      data-label-id="${o(l.id)}"
      data-assigned="${s}"
      style="--chip-color:${o(l.color)}"
      title="${s?"Remove":"Assign"} label ${o(l.name)}"
    >${o(l.name)}</button>`}).join(""),n=i.length>0?`<div class="card-label-section">
        <div class="card-label-chips">${e}</div>
        <details class="card-label-picker">
          <summary class="card-label-picker-toggle">Labels ▾</summary>
          <div class="card-label-picker-list">${r}</div>
        </details>
      </div>`:t.labels&&t.labels.length>0?`<div class="card-label-chips">${e}</div>`:"";return`
    <article
      class="card${a?"":" hidden-by-filter"}"
      draggable="true"
      data-card-id="${o(t.id)}"
      title="Drag to move"
    >
      <div class="card-text">${o(t.text)}</div>
      ${n}
    </article>
  `}function q(){return`
    <aside class="label-manager">
      <h2 class="label-manager-title">Labels</h2>
      <ul class="label-list">${i.map(a=>`
    <li class="label-row" data-label-id="${o(a.id)}">
      <span class="label-swatch" style="background:${o(a.color)}"></span>
      <span class="label-name-display">${o(a.name)}</span>
      <input class="label-edit-name" type="text" value="${o(a.name)}" maxlength="50" style="display:none" />
      <input class="label-edit-color" type="color" value="${o(a.color)}" style="display:none" />
      <button class="label-btn label-edit-btn" data-label-id="${o(a.id)}">Edit</button>
      <button class="label-btn label-save-btn" data-label-id="${o(a.id)}" style="display:none">Save</button>
      <button class="label-btn label-cancel-btn" data-label-id="${o(a.id)}" style="display:none">Cancel</button>
      <button class="label-btn label-delete-btn" data-label-id="${o(a.id)}">Delete</button>
    </li>
  `).join("")}</ul>
      <form class="label-create-form" id="label-create-form">
        <input class="label-create-name" name="name" type="text" maxlength="50" placeholder="Label name…" autocomplete="off" required />
        <input class="label-create-color" name="color" type="color" value="#3b82f6" />
        <button type="submit" class="label-btn label-create-btn">Create</button>
      </form>
      <div class="label-manager-error" id="label-manager-error"></div>
    </aside>
  `}function A(){document.querySelectorAll(".add-card").forEach(e=>{e.addEventListener("submit",async r=>{r.preventDefault();const n=e.elements.text,l=n.value.trim();l&&(n.value="",await T(e.dataset.columnId,l))})}),document.querySelectorAll(".card").forEach(e=>{e.addEventListener("dragstart",r=>{y=e.dataset.cardId,e.classList.add("dragging"),r.dataTransfer.effectAllowed="move"}),e.addEventListener("dragend",()=>{e.classList.remove("dragging"),y=null})}),document.querySelectorAll(".cards").forEach(e=>{e.addEventListener("dragover",r=>{r.preventDefault(),e.classList.add("drop-target")}),e.addEventListener("dragleave",()=>e.classList.remove("drop-target")),e.addEventListener("drop",async r=>{if(r.preventDefault(),e.classList.remove("drop-target"),!y)return;const n=e.dataset.columnId,{afterId:l,beforeId:s}=j(e,y);k(y,n,s,l),p(),await O(y,n,s,l)})}),document.querySelectorAll("[data-filter-label-id]").forEach(e=>{e.addEventListener("click",()=>{const r=e.dataset.filterLabelId;f.has(r)?f.delete(r):f.add(r),p()})});const t=document.getElementById("filter-clear-btn");t&&t.addEventListener("click",()=>{f.clear(),p()}),document.querySelectorAll(".label-assign-btn").forEach(e=>{e.addEventListener("click",async r=>{r.stopPropagation();const{cardId:n,labelId:l,assigned:s}=e.dataset;s==="true"?await M(n,l):await D(n,l)})});const a=document.getElementById("label-create-form");a&&a.addEventListener("submit",async e=>{e.preventDefault();const r=a.elements.name.value.trim(),n=a.elements.color.value;if(!r)return;const l=await N(r,n),s=document.getElementById("label-manager-error");s&&(s.textContent=l||""),l||(a.elements.name.value="")}),document.querySelectorAll(".label-edit-btn").forEach(e=>{e.addEventListener("click",()=>{const r=document.querySelector(`.label-row[data-label-id="${e.dataset.labelId}"]`);r&&(r.querySelector(".label-name-display").style.display="none",r.querySelector(".label-swatch").style.display="none",r.querySelector(".label-edit-name").style.display="",r.querySelector(".label-edit-color").style.display="",r.querySelector(".label-edit-btn").style.display="none",r.querySelector(".label-save-btn").style.display="",r.querySelector(".label-cancel-btn").style.display="")})}),document.querySelectorAll(".label-save-btn").forEach(e=>{e.addEventListener("click",async()=>{const r=document.querySelector(`.label-row[data-label-id="${e.dataset.labelId}"]`);if(!r)return;const n=r.querySelector(".label-edit-name").value.trim(),l=r.querySelector(".label-edit-color").value,s=document.getElementById("label-manager-error"),m=await P(e.dataset.labelId,n,l);s&&(s.textContent=m||"")})}),document.querySelectorAll(".label-cancel-btn").forEach(e=>{e.addEventListener("click",()=>{p()})}),document.querySelectorAll(".label-delete-btn").forEach(e=>{e.addEventListener("click",async()=>{const r=document.getElementById("label-manager-error"),n=await B(e.dataset.labelId);r&&(r.textContent=n||"")})})}function j(t,a){const e=[...t.querySelectorAll(".card")].map(n=>n.dataset.cardId),r=e.indexOf(a);return{afterId:r>0?e[r-1]:null,beforeId:r>=0&&r<e.length-1?e[r+1]:null}}function k(t,a,e,r){const n=w(t);if(!n)return;const l=d.columns.find(h=>h.id===a);if(!l)return;const s=r?l.cards.findIndex(h=>h.id===r):-1,m=e?l.cards.findIndex(h=>h.id===e):-1;let g=l.cards.length;s!==-1?g=s+1:m!==-1&&(g=m),l.cards.splice(g,0,{...n,column_id:a,optimistic:!0})}async function T(t,a){try{const e=await fetch(`${b}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:t,text:a})});if(!e.ok)throw new Error((await e.json()).error||"Create failed")}catch(e){u(`Create failed: ${e.message}`,!0)}}async function O(t,a,e,r){try{const n=await fetch(`${b}/api/cards/${t}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:a,beforeId:e,afterId:r})});if(!n.ok)throw new Error((await n.json()).error||"Move failed")}catch(n){u(`Move failed: ${n.message}`,!0)}}async function N(t,a){try{const e=await fetch(`${b}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:t,color:a})});return e.ok?null:(await e.json()).error||"Create failed"}catch(e){return e.message}}async function P(t,a,e){try{const r=await fetch(`${b}/api/labels/${t}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:a,color:e})});return r.ok?null:(await r.json()).error||"Update failed"}catch(r){return r.message}}async function B(t){try{const a=await fetch(`${b}/api/labels/${t}`,{method:"DELETE"});return!a.ok&&a.status!==404?(await a.json()).error||"Delete failed":null}catch(a){return a.message}}async function D(t,a){try{const e=await fetch(`${b}/api/cards/${t}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:a})});if(!e.ok)throw new Error((await e.json()).error||"Assign failed")}catch(e){u(`Assign failed: ${e.message}`,!0)}}async function M(t,a){try{const e=await fetch(`${b}/api/cards/${t}/labels/${a}`,{method:"DELETE"});if(!e.ok)throw new Error((await e.json()).error||"Unassign failed")}catch(e){u(`Unassign failed: ${e.message}`,!0)}}function F(t){if(t.board){d=v(t.board),p(),u("Synced");return}if(!t.card)return;const a={...t.card,labels:t.card.labels||[]};w(a.id);const e=d.columns.find(r=>r.id===a.column_id||r.id===t.columnId);e&&(e.cards.push(a),e.cards.sort(E),p(),u("Synced"))}function J(t){switch(t.type){case"label-created":t.label&&!i.find(a=>a.id===t.label.id)&&(i.push(t.label),i.sort((a,e)=>a.name.localeCompare(e.name)));break;case"label-updated":if(t.label){const a=i.findIndex(e=>e.id===t.label.id);a!==-1?i[a]=t.label:i.push(t.label),i.sort((e,r)=>e.name.localeCompare(r.name))}t.board&&(d=v(t.board));break;case"label-deleted":t.labelId&&(i=i.filter(a=>a.id!==t.labelId),f.delete(t.labelId)),t.board&&(d=v(t.board));break;case"card-label-assigned":case"card-label-unassigned":if(t.card){const a={...t.card,labels:t.card.labels||[]};w(a.id);const e=d.columns.find(r=>r.id===a.column_id);e&&(e.cards.push(a),e.cards.sort(E))}t.board&&(d=v(t.board));break}p(),u("Synced")}async function _(){const t=await fetch(`${b}/api/board`);if(!t.ok)throw new Error("Could not load board");d=v(await t.json())}async function H(){const t=await fetch(`${b}/api/labels`);if(!t.ok)throw new Error("Could not load labels");i=await t.json()}function U(){c==null||c.close(),c=new EventSource(`${b}/api/stream`),c.addEventListener("connected",()=>u("Live")),c.addEventListener("mutation",t=>{F(JSON.parse(t.data))}),c.addEventListener("label",t=>{J(JSON.parse(t.data))}),c.onerror=()=>u("Reconnecting…",!0)}function u(t,a=!1){const e=document.querySelector("#status");e&&(e.textContent=t,e.classList.toggle("warn",a)),clearTimeout(L),a&&(L=setTimeout(()=>u((c==null?void 0:c.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function z(){$.innerHTML='<div class="loading">Loading board…</div>';try{await Promise.all([_(),H()]),p(),U()}catch(t){$.innerHTML=`<div class="loading error">${o(t.message)}</div>`}}z();
