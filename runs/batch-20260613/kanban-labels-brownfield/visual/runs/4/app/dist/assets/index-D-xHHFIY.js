(function(){const a=document.createElement("link").relList;if(a&&a.supports&&a.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))n(r);new MutationObserver(r=>{for(const l of r)if(l.type==="childList")for(const o of l.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&n(o)}).observe(document,{childList:!0,subtree:!0});function t(r){const l={};return r.integrity&&(l.integrity=r.integrity),r.referrerPolicy&&(l.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?l.credentials="include":r.crossOrigin==="anonymous"?l.credentials="omit":l.credentials="same-origin",l}function n(r){if(r.ep)return;r.ep=!0;const l=t(r);fetch(r.href,l)}})();const b="http://localhost:3001",g=document.querySelector("#app");let f={columns:[]},s=[],p=new Set,y=null,d=null,E=null;function i(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function C(e){for(const a of f.columns){const t=a.cards.findIndex(n=>n.id===e);if(t!==-1)return{column:a,index:t,card:a.cards[t]}}return null}function L(e){let a=null;for(const t of f.columns){const n=t.cards.findIndex(r=>r.id===e);if(n!==-1){const[r]=t.cards.splice(n,1);a=r}}return a}function w(e){const a=new Set;return{columns:[...e.columns||[]].map(n=>({...n,cards:[...n.cards||[]].filter(r=>a.has(r.id)?!1:(a.add(r.id),!0)).map(r=>({...r,labels:r.labels||[]})).sort($)})).sort((n,r)=>Number(n.position)-Number(r.position)||n.id.localeCompare(r.id))}}function $(e,a){return Number(e.position)-Number(a.position)||String(e.created_at).localeCompare(String(a.created_at))||e.id.localeCompare(a.id)}function u(){g.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    ${I()}
    <main class="board">
      ${f.columns.map(A).join("")}
    </main>
    ${T()}
  `,k()}function I(){return s.length===0?"":`
    <div class="filter-bar">
      <span class="filter-label-text">Filter:</span>
      ${s.map(e=>`
        <button
          class="filter-chip${p.has(e.id)?" active":""}"
          data-filter-label-id="${i(e.id)}"
          style="--chip-color:${i(e.color)}"
        >${i(e.name)}</button>
      `).join("")}
      ${p.size>0?'<button class="filter-clear" id="clear-filters">Clear</button>':""}
    </div>
  `}function A(e){const a=p.size===0?e.cards:e.cards.filter(t=>(t.labels||[]).some(n=>p.has(n.id)));return`
    <section class="column" data-column-id="${i(e.id)}">
      <h2>${i(e.title)}</h2>
      <form class="add-card" data-column-id="${i(e.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${i(e.id)}">
        ${a.map(x).join("")}
      </div>
    </section>
  `}function x(e){const a=e.labels||[],t=a.length>0?`<div class="card-chips">${a.map(o=>`
        <span class="label-chip" style="background:${i(o.color)}" title="${i(o.name)}">${i(o.name)}</span>
      `).join("")}</div>`:"",n=new Set(a.map(o=>o.id)),r=s.map(o=>{const m=n.has(o.id);return`
      <button
        class="label-menu-item${m?" assigned":""}"
        data-card-id="${i(e.id)}"
        data-label-id="${i(o.id)}"
        data-assigned="${m}"
        style="--chip-color:${i(o.color)}"
      >
        <span class="label-menu-dot" style="background:${i(o.color)}"></span>
        ${i(o.name)}
        ${m?'<span class="label-menu-check">✓</span>':""}
      </button>
    `}).join(""),l=`
    <div class="card-label-menu-wrap">
      <button class="card-label-btn" data-card-id="${i(e.id)}" title="Manage labels">Labels</button>
      <div class="card-label-menu" id="label-menu-${i(e.id)}" hidden>
        ${s.length===0?'<span class="label-menu-empty">No labels yet</span>':r}
      </div>
    </div>
  `;return`
    <article class="card" draggable="true" data-card-id="${i(e.id)}" title="Drag to move">
      <div class="card-body">${i(e.text)}</div>
      ${t}
      ${l}
    </article>
  `}function T(){return`
    <div class="label-manager-wrap">
      <details class="label-manager" id="label-manager">
        <summary class="label-manager-toggle">▸ Manage Labels</summary>
        <div class="label-manager-body">
          <form class="label-create-form" id="label-create-form">
            <input
              name="name"
              type="text"
              maxlength="50"
              placeholder="Label name…"
              autocomplete="off"
              class="label-name-input"
            />
            <input name="color" type="color" value="#3b82f6" class="label-color-input" title="Pick a color" />
            <button type="submit" class="label-create-btn">Add Label</button>
          </form>
          <div class="label-list" id="label-list">
            ${s.length===0?'<p class="label-list-empty">No labels yet.</p>':s.map(N).join("")}
          </div>
        </div>
      </details>
    </div>
  `}function N(e){return`
    <div class="label-row" data-label-id="${i(e.id)}">
      <span class="label-swatch" style="background:${i(e.color)}"></span>
      <span class="label-row-name" data-label-id="${i(e.id)}">${i(e.name)}</span>
      <div class="label-row-actions">
        <button class="label-edit-btn" data-label-id="${i(e.id)}" title="Edit">✏️</button>
        <button class="label-delete-btn" data-label-id="${i(e.id)}" title="Delete">🗑</button>
      </div>
    </div>
  `}function k(){document.querySelectorAll(".add-card").forEach(t=>{t.addEventListener("submit",async n=>{n.preventDefault();const r=t.elements.text,l=r.value.trim();if(!l)return;r.value="";const o=t.dataset.columnId;await D(o,l)})}),document.querySelectorAll(".card").forEach(t=>{t.addEventListener("dragstart",n=>{y=t.dataset.cardId,t.classList.add("dragging"),n.dataTransfer.effectAllowed="move"}),t.addEventListener("dragend",()=>{t.classList.remove("dragging"),y=null})}),document.querySelectorAll(".cards").forEach(t=>{t.addEventListener("dragover",n=>{n.preventDefault(),t.classList.add("drop-target")}),t.addEventListener("dragleave",()=>t.classList.remove("drop-target")),t.addEventListener("drop",async n=>{if(n.preventDefault(),t.classList.remove("drop-target"),!y)return;const r=t.dataset.columnId,{afterId:l,beforeId:o}=O(t,y);j(y,r,o,l),u(),await P(y,r,o,l)})}),document.querySelectorAll(".filter-chip").forEach(t=>{t.addEventListener("click",()=>{const n=t.dataset.filterLabelId;p.has(n)?p.delete(n):p.add(n),u()})});const e=document.getElementById("clear-filters");e&&e.addEventListener("click",()=>{p.clear(),u()});const a=document.getElementById("label-create-form");a&&a.addEventListener("submit",async t=>{t.preventDefault();const n=a.elements.name.value.trim(),r=a.elements.color.value;if(!n)return;const l=await M(n,r);l?S(l):a.elements.name.value=""}),document.querySelectorAll(".label-edit-btn").forEach(t=>{t.addEventListener("click",()=>q(t.dataset.labelId))}),document.querySelectorAll(".label-delete-btn").forEach(t=>{t.addEventListener("click",async()=>{const n=t.dataset.labelId,r=s.find(l=>l.id===n);r&&confirm(`Delete label "${r.name}"? This will remove it from all cards.`)&&await H(n)})}),document.querySelectorAll(".card-label-btn").forEach(t=>{t.addEventListener("click",n=>{n.stopPropagation();const r=t.dataset.cardId,l=document.getElementById(`label-menu-${r}`);l&&(document.querySelectorAll(".card-label-menu").forEach(o=>{o!==l&&(o.hidden=!0)}),l.hidden=!l.hidden)})}),document.querySelectorAll(".label-menu-item").forEach(t=>{t.addEventListener("click",async n=>{n.stopPropagation();const{cardId:r,labelId:l,assigned:o}=t.dataset;o==="true"?await F(r,l):await _(r,l)})}),document.addEventListener("click",()=>{document.querySelectorAll(".card-label-menu").forEach(t=>t.hidden=!0)})}function q(e){const a=s.find(r=>r.id===e);if(!a)return;const t=document.querySelector(`.label-row[data-label-id="${e}"]`);if(!t)return;t.innerHTML=`
    <form class="label-edit-form" data-label-id="${i(e)}">
      <input name="name" type="text" maxlength="50" value="${i(a.name)}" class="label-name-input" autocomplete="off" />
      <input name="color" type="color" value="${i(a.color)}" class="label-color-input" />
      <button type="submit" class="label-create-btn">Save</button>
      <button type="button" class="label-cancel-btn" data-label-id="${i(e)}">Cancel</button>
    </form>
  `;const n=t.querySelector(".label-edit-form");n.addEventListener("submit",async r=>{r.preventDefault();const l=n.elements.name.value.trim(),o=n.elements.color.value;if(!l)return;const m=await B(e,l,o);m&&S(m)}),t.querySelector(".label-cancel-btn").addEventListener("click",()=>u())}function S(e){let a=document.getElementById("label-error");if(!a){a=document.createElement("div"),a.id="label-error",a.className="label-error";const t=document.querySelector(".label-manager-body");t&&t.prepend(a)}a.textContent=e,clearTimeout(a._timer),a._timer=setTimeout(()=>a.remove(),4e3)}function O(e,a){const t=[...e.querySelectorAll(".card")].map(r=>r.dataset.cardId),n=t.indexOf(a);return{afterId:n>0?t[n-1]:null,beforeId:n>=0&&n<t.length-1?t[n+1]:null}}function j(e,a,t,n){const r=L(e);if(!r)return;const l=f.columns.find(h=>h.id===a);if(!l)return;const o=n?l.cards.findIndex(h=>h.id===n):-1,m=t?l.cards.findIndex(h=>h.id===t):-1;let v=l.cards.length;o!==-1?v=o+1:m!==-1&&(v=m),l.cards.splice(v,0,{...r,column_id:a,optimistic:!0})}async function D(e,a){try{const t=await fetch(`${b}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:e,text:a})});if(!t.ok)throw new Error((await t.json()).error||"Create failed")}catch(t){c(`Create failed: ${t.message}`,!0)}}async function P(e,a,t,n){try{const r=await fetch(`${b}/api/cards/${e}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:a,beforeId:t,afterId:n})});if(!r.ok)throw new Error((await r.json()).error||"Move failed")}catch(r){c(`Move failed: ${r.message}`,!0)}}async function M(e,a){try{const t=await fetch(`${b}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:e,color:a})});return t.ok?null:(await t.json()).error||"Failed to create label"}catch{return"Network error"}}async function B(e,a,t){try{const n=await fetch(`${b}/api/labels/${e}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:a,color:t})});return n.ok?null:(await n.json()).error||"Failed to update label"}catch{return"Network error"}}async function H(e){try{const a=await fetch(`${b}/api/labels/${e}`,{method:"DELETE"});!a.ok&&a.status!==404&&c("Delete label failed",!0)}catch{c("Delete label failed",!0)}}async function _(e,a){try{(await fetch(`${b}/api/cards/${e}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:a})})).ok||c("Assign label failed",!0)}catch{c("Assign label failed",!0)}}async function F(e,a){try{(await fetch(`${b}/api/cards/${e}/labels/${a}`,{method:"DELETE"})).ok||c("Unassign label failed",!0)}catch{c("Unassign label failed",!0)}}function J(e){if(e.board){f=w(e.board),u(),c("Synced");return}if(!e.card)return;const a=e.card;L(a.id);const t=f.columns.find(n=>n.id===a.column_id||n.id===e.columnId);t&&(t.cards.push({...a,labels:a.labels||[]}),t.cards.sort($),u(),c("Synced"))}function U(e){const{type:a}=e;if(a==="label-created"){s.find(t=>t.id===e.label.id)||(s.push(e.label),s.sort((t,n)=>t.name.localeCompare(n.name))),u(),c("Synced");return}if(a==="label-updated"){const t=s.findIndex(n=>n.id===e.label.id);t!==-1?s[t]=e.label:s.push(e.label),s.sort((n,r)=>n.name.localeCompare(r.name));for(const n of f.columns)for(const r of n.cards)r.labels=(r.labels||[]).map(l=>l.id===e.label.id?e.label:l);u(),c("Synced");return}if(a==="label-deleted"){s=s.filter(t=>t.id!==e.labelId),p.delete(e.labelId);for(const t of f.columns)for(const n of t.cards)n.labels=(n.labels||[]).filter(r=>r.id!==e.labelId);u(),c("Synced");return}if(a==="label-assigned"||a==="label-unassigned"){if(e.card){const t=C(e.card.id);if(t)t.card.labels=e.card.labels||[];else{const n=f.columns.find(r=>r.id===e.card.column_id);n&&(n.cards.push({...e.card,labels:e.card.labels||[]}),n.cards.sort($))}}u(),c("Synced");return}}async function z(){const e=await fetch(`${b}/api/board`);if(!e.ok)throw new Error("Could not load board");f=w(await e.json())}async function R(){const e=await fetch(`${b}/api/labels`);if(!e.ok)throw new Error("Could not load labels");s=await e.json()}function K(){d==null||d.close(),d=new EventSource(`${b}/api/stream`),d.addEventListener("connected",()=>c("Live")),d.addEventListener("mutation",e=>{J(JSON.parse(e.data))}),d.addEventListener("label",e=>{U(JSON.parse(e.data))}),d.onerror=()=>c("Reconnecting…",!0)}function c(e,a=!1){const t=document.querySelector("#status");t&&(t.textContent=e,t.classList.toggle("warn",a)),clearTimeout(E),a&&(E=setTimeout(()=>c((d==null?void 0:d.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function G(){g.innerHTML='<div class="loading">Loading board…</div>';try{await Promise.all([z(),R()]),u(),K()}catch(e){g.innerHTML=`<div class="loading error">${i(e.message)}</div>`}}G();
