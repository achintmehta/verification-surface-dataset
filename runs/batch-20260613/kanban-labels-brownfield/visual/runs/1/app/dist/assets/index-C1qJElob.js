(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))n(r);new MutationObserver(r=>{for(const d of r)if(d.type==="childList")for(const f of d.addedNodes)f.tagName==="LINK"&&f.rel==="modulepreload"&&n(f)}).observe(document,{childList:!0,subtree:!0});function a(r){const d={};return r.integrity&&(d.integrity=r.integrity),r.referrerPolicy&&(d.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?d.credentials="include":r.crossOrigin==="anonymous"?d.credentials="omit":d.credentials="same-origin",d}function n(r){if(r.ep)return;r.ep=!0;const d=a(r);fetch(r.href,d)}})();const h="http://localhost:3001",$=document.querySelector("#app");let v={columns:[]},c=[],y=new Set,L=null,b=null,I=null;function s(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function x(e){for(const t of v.columns){const a=t.cards.findIndex(n=>n.id===e);if(a!==-1)return{column:t,index:a,card:t.cards[a]}}return null}function S(e){let t=null;for(const a of v.columns){const n=a.cards.findIndex(r=>r.id===e);if(n!==-1){const[r]=a.cards.splice(n,1);t=r}}return t}function w(e){const t=new Set;return{columns:[...e.columns||[]].map(n=>({...n,cards:[...n.cards||[]].filter(r=>t.has(r.id)?!1:(t.add(r.id),!0)).map(r=>({...r,labels:r.labels||[]})).sort(C)})).sort((n,r)=>Number(n.position)-Number(r.position)||n.id.localeCompare(r.id))}}function C(e,t){return Number(e.position)-Number(t.position)||String(e.created_at).localeCompare(String(t.created_at))||e.id.localeCompare(t.id)}function k(e){if(y.size===0)return!0;const t=new Set((e.labels||[]).map(a=>a.id));for(const a of y)if(t.has(a))return!0;return!1}function g(){$.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    ${T()}
    <main class="board">
      ${v.columns.map(B).join("")}
    </main>
    ${M()}
  `,N()}function T(){const e=c.map(a=>`<button
      class="filter-chip${y.has(a.id)?" active":""}"
      data-filter-label-id="${s(a.id)}"
      style="--chip-color:${s(a.color)}"
      title="Filter by ${s(a.name)}"
    >${s(a.name)}</button>`).join(""),t=y.size>0?'<button class="filter-clear" id="filter-clear-btn">Clear filter</button>':"";return`
    <div class="label-bar">
      <div class="label-bar-filters">
        <span class="label-bar-title">Filter:</span>
        ${e||'<span class="label-bar-empty">No labels yet</span>'}
        ${t}
      </div>
      <button class="manage-labels-btn" id="open-label-manager">Manage Labels</button>
    </div>
  `}function B(e){return`
    <section class="column" data-column-id="${s(e.id)}">
      <h2>${s(e.title)}</h2>
      <form class="add-card" data-column-id="${s(e.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${s(e.id)}">
        ${e.cards.map(t=>j(t)).join("")}
      </div>
    </section>
  `}function j(e){const t=k(e),a=(e.labels||[]).map(n=>`
    <span class="label-chip" style="background:${s(n.color)}" title="${s(n.name)}">${s(n.name)}</span>
  `).join("");return`
    <article
      class="card${t?"":" card-hidden"}"
      draggable="true"
      data-card-id="${s(e.id)}"
      title="Drag to move"
    >
      <div class="card-text">${s(e.text)}</div>
      ${a?`<div class="card-labels">${a}</div>`:""}
      <button class="card-label-btn" data-card-id="${s(e.id)}" title="Assign labels">🏷</button>
    </article>
  `}function M(){return`
    <div class="modal-backdrop hidden" id="label-manager-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Label Manager">
        <div class="modal-header">
          <h2>Label Manager</h2>
          <button class="modal-close" id="close-label-manager">✕</button>
        </div>
        <ul class="lm-list">${c.map(t=>`
    <li class="lm-row" data-label-id="${s(t.id)}">
      <span class="lm-swatch" style="background:${s(t.color)}"></span>
      <span class="lm-name">${s(t.name)}</span>
      <button class="lm-edit-btn" data-label-id="${s(t.id)}" title="Edit">✏️</button>
      <button class="lm-delete-btn" data-label-id="${s(t.id)}" title="Delete">🗑</button>
    </li>
  `).join("")||'<li class="lm-empty">No labels yet.</li>'}</ul>
        <form class="lm-create-form" id="lm-create-form">
          <input name="name" type="text" maxlength="60" placeholder="Label name…" autocomplete="off" required />
          <input name="color" type="color" value="#3b82f6" title="Pick a color" />
          <button type="submit">Add</button>
        </form>
      </div>
    </div>
    <div class="modal-backdrop hidden" id="label-edit-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Edit Label">
        <div class="modal-header">
          <h2>Edit Label</h2>
          <button class="modal-close" id="close-label-edit">✕</button>
        </div>
        <form class="lm-edit-form" id="lm-edit-form">
          <input type="hidden" name="id" />
          <input name="name" type="text" maxlength="60" placeholder="Label name…" autocomplete="off" required />
          <input name="color" type="color" title="Pick a color" />
          <button type="submit">Save</button>
        </form>
      </div>
    </div>
    <div class="modal-backdrop hidden" id="card-label-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Assign Labels">
        <div class="modal-header">
          <h2>Assign Labels</h2>
          <button class="modal-close" id="close-card-label">✕</button>
        </div>
        <div id="card-label-list"></div>
      </div>
    </div>
  `}function N(){var e,t,a,n,r,d,f;document.querySelectorAll(".add-card").forEach(l=>{l.addEventListener("submit",async o=>{o.preventDefault();const i=l.elements.text,u=i.value.trim();u&&(i.value="",await D(l.dataset.columnId,u))})}),document.querySelectorAll(".card").forEach(l=>{l.addEventListener("dragstart",o=>{L=l.dataset.cardId,l.classList.add("dragging"),o.dataTransfer.effectAllowed="move"}),l.addEventListener("dragend",()=>{l.classList.remove("dragging"),L=null})}),document.querySelectorAll(".cards").forEach(l=>{l.addEventListener("dragover",o=>{o.preventDefault(),l.classList.add("drop-target")}),l.addEventListener("dragleave",()=>l.classList.remove("drop-target")),l.addEventListener("drop",async o=>{if(o.preventDefault(),l.classList.remove("drop-target"),!L)return;const i=l.dataset.columnId,{afterId:u,beforeId:p}=q(l,L);P(L,i,p,u),g(),await H(L,i,p,u)})}),document.querySelectorAll(".filter-chip").forEach(l=>{l.addEventListener("click",()=>{const o=l.dataset.filterLabelId;y.has(o)?y.delete(o):y.add(o),g()})}),(e=document.getElementById("filter-clear-btn"))==null||e.addEventListener("click",()=>{y.clear(),g()}),(t=document.getElementById("open-label-manager"))==null||t.addEventListener("click",()=>{document.getElementById("label-manager-modal").classList.remove("hidden")}),(a=document.getElementById("close-label-manager"))==null||a.addEventListener("click",()=>{document.getElementById("label-manager-modal").classList.add("hidden")}),(n=document.getElementById("lm-create-form"))==null||n.addEventListener("submit",async l=>{l.preventDefault();const o=l.target,i=o.elements.name.value.trim(),u=o.elements.color.value;if(!i)return;const p=await U(i,u);p?m(`Label error: ${p}`,!0):o.elements.name.value=""}),document.querySelectorAll(".lm-edit-btn").forEach(l=>{l.addEventListener("click",()=>{const o=l.dataset.labelId,i=c.find(E=>E.id===o);if(!i)return;const u=document.getElementById("label-edit-modal"),p=document.getElementById("lm-edit-form");p.elements.id.value=i.id,p.elements.name.value=i.name,p.elements.color.value=i.color,u.classList.remove("hidden")})}),(r=document.getElementById("close-label-edit"))==null||r.addEventListener("click",()=>{document.getElementById("label-edit-modal").classList.add("hidden")}),(d=document.getElementById("lm-edit-form"))==null||d.addEventListener("submit",async l=>{l.preventDefault();const o=l.target,i=o.elements.id.value,u=o.elements.name.value.trim(),p=o.elements.color.value;if(!u)return;const E=await J(i,u,p);E?m(`Label error: ${E}`,!0):document.getElementById("label-edit-modal").classList.add("hidden")}),document.querySelectorAll(".lm-delete-btn").forEach(l=>{l.addEventListener("click",async()=>{const o=l.dataset.labelId,i=c.find(p=>p.id===o);if(!i||!confirm(`Delete label "${i.name}"? This will remove it from all cards.`))return;const u=await F(o);u&&m(`Label error: ${u}`,!0)})}),document.querySelectorAll(".card-label-btn").forEach(l=>{l.addEventListener("click",o=>{o.stopPropagation(),O(l.dataset.cardId)})}),(f=document.getElementById("close-card-label"))==null||f.addEventListener("click",()=>{document.getElementById("card-label-modal").classList.add("hidden")}),document.querySelectorAll(".modal-backdrop").forEach(l=>{l.addEventListener("click",o=>{o.target===l&&l.classList.add("hidden")})})}function O(e){const t=x(e);if(!t)return;const a=t.card,n=new Set((a.labels||[]).map(d=>d.id)),r=document.getElementById("card-label-list");r&&(c.length===0?r.innerHTML='<p class="lm-empty">No labels exist yet. Create some in Label Manager.</p>':(r.innerHTML=c.map(d=>{const f=n.has(d.id);return`
        <label class="cl-row">
          <input type="checkbox" class="cl-checkbox"
            data-card-id="${s(e)}"
            data-label-id="${s(d.id)}"
            ${f?"checked":""}
          />
          <span class="lm-swatch" style="background:${s(d.color)}"></span>
          <span>${s(d.name)}</span>
        </label>
      `}).join(""),r.querySelectorAll(".cl-checkbox").forEach(d=>{d.addEventListener("change",async()=>{const f=d.dataset.cardId,l=d.dataset.labelId;d.checked?await _(f,l):await z(f,l)})})),document.getElementById("card-label-modal").classList.remove("hidden"))}function q(e,t){const a=[...e.querySelectorAll(".card")].map(r=>r.dataset.cardId),n=a.indexOf(t);return{afterId:n>0?a[n-1]:null,beforeId:n>=0&&n<a.length-1?a[n+1]:null}}function P(e,t,a,n){const r=S(e);if(!r)return;const d=v.columns.find(i=>i.id===t);if(!d)return;const f=n?d.cards.findIndex(i=>i.id===n):-1,l=a?d.cards.findIndex(i=>i.id===a):-1;let o=d.cards.length;f!==-1?o=f+1:l!==-1&&(o=l),d.cards.splice(o,0,{...r,column_id:t,optimistic:!0})}async function D(e,t){try{const a=await fetch(`${h}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:e,text:t})});if(!a.ok)throw new Error((await a.json()).error||"Create failed")}catch(a){m(`Create failed: ${a.message}`,!0)}}async function H(e,t,a,n){try{const r=await fetch(`${h}/api/cards/${e}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:t,beforeId:a,afterId:n})});if(!r.ok)throw new Error((await r.json()).error||"Move failed")}catch(r){m(`Move failed: ${r.message}`,!0),await A()}}async function U(e,t){try{const a=await fetch(`${h}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:e,color:t})});return a.ok?null:(await a.json()).error||"Create failed"}catch(a){return a.message}}async function J(e,t,a){try{const n=await fetch(`${h}/api/labels/${e}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:t,color:a})});return n.ok?null:(await n.json()).error||"Update failed"}catch(n){return n.message}}async function F(e){try{const t=await fetch(`${h}/api/labels/${e}`,{method:"DELETE"});return!t.ok&&t.status!==204?(await t.json()).error||"Delete failed":null}catch(t){return t.message}}async function _(e,t){try{const a=await fetch(`${h}/api/cards/${e}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:t})});if(!a.ok){const n=(await a.json()).error||"Assign failed";m(`Assign failed: ${n}`,!0)}}catch(a){m(`Assign failed: ${a.message}`,!0)}}async function z(e,t){try{const a=await fetch(`${h}/api/cards/${e}/labels/${t}`,{method:"DELETE"});if(!a.ok){const n=(await a.json()).error||"Unassign failed";m(`Unassign failed: ${n}`,!0)}}catch(a){m(`Unassign failed: ${a.message}`,!0)}}function K(e){if(e.board){v=w(e.board),g(),m("Synced");return}if(!e.card)return;const t=e.card;S(t.id);const a=v.columns.find(n=>n.id===t.column_id||n.id===e.columnId);a&&(a.cards.push({...t,labels:t.labels||[]}),a.cards.sort(C),g(),m("Synced"))}function R(e){if(e.board&&(v=w(e.board)),e.type==="label-create"&&e.label)c.find(t=>t.id===e.label.id)||(c.push(e.label),c.sort((t,a)=>t.name.localeCompare(a.name)));else if(e.type==="label-update"&&e.label){const t=c.findIndex(a=>a.id===e.label.id);t!==-1?c[t]=e.label:c.push(e.label),c.sort((a,n)=>a.name.localeCompare(n.name))}else e.type==="label-delete"&&(c=c.filter(t=>t.id!==e.labelId),y.delete(e.labelId));g(),m("Synced")}async function A(){const e=await fetch(`${h}/api/board`);if(!e.ok)throw new Error("Could not load board");v=w(await e.json())}async function G(){const e=await fetch(`${h}/api/labels`);if(!e.ok)throw new Error("Could not load labels");c=await e.json()}function Q(){b==null||b.close(),b=new EventSource(`${h}/api/stream`),b.addEventListener("connected",()=>m("Live")),b.addEventListener("mutation",e=>{K(JSON.parse(e.data))}),b.addEventListener("label-mutation",e=>{R(JSON.parse(e.data))}),b.onerror=()=>m("Reconnecting…",!0)}function m(e,t=!1){const a=document.querySelector("#status");a&&(a.textContent=e,a.classList.toggle("warn",t)),clearTimeout(I),t&&(I=setTimeout(()=>m((b==null?void 0:b.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function V(){$.innerHTML='<div class="loading">Loading board…</div>';try{await Promise.all([A(),G()]),g(),Q()}catch(e){$.innerHTML=`<div class="loading error">${s(e.message)}</div>`}}V();
